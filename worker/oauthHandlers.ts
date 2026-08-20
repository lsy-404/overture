// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// The four OAuth routes. worker/oauth.ts holds the crypto and cookie shapes;
// this file is the network calls to Cloudflare and the Hono wiring around
// them. Never echo an upstream error body back to the browser — S3-style and
// OAuth error responses alike can carry request internals derived from a
// secret, and CLAUDE.md's no-logging rule means there is nowhere else for
// that detail to go but silently absorbed.

import type { Context } from "hono";
import { formatScopeParam } from "../shared/oauthScopes";
import { jsonResponse } from "./http";
import {
  decryptSession,
  encryptSession,
  expireCookie,
  generateStateNonce,
  hashStateNonce,
  isValidPackageHash,
  parseAndValidateScope,
  parseCookies,
  serializeCookie,
  signStateCookie,
  STATE_COOKIE_MAX_AGE_SECONDS,
  stateNonceMatches,
  verifyStateCookie,
  type SessionAccount,
} from "./oauth";

type RelayContext = Context<{ Bindings: Env }>;

const CF_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const CF_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CF_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const CF_ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts";

// Both cookies carry the __Host- prefix: host-only, so a sibling host on the
// same registrable domain (an attacker-controlled package deployed to
// music.example.com against an Overture on deploy.example.com) cannot toss a
// cookie of either name up to the parent domain. That is what stops a login-CSRF
// fixation, so ov_state needs it as much as ov_session — and __Host- forces
// Path=/, which is why the state cookie is no longer scoped to /oauth.
const OV_STATE_COOKIE = "__Host-ov_state";
const OV_SESSION_COOKIE = "__Host-ov_session";
// SameSite=Lax on ov_state only: it has to survive the top-level, cross-site
// navigation that Cloudflare's own consent-page redirect back to
// /oauth/callback performs. ov_session has no such requirement and stays Strict.
const STATE_COOKIE_OPTS = { path: "/", sameSite: "Lax" as const };
const SESSION_COOKIE_OPTS = { path: "/", sameSite: "Strict" as const };

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function basicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

// GET /oauth/authorize?scope=...&pkg=... — starts the Cloudflare consent flow.
export async function handleOauthAuthorize(c: RelayContext): Promise<Response> {
  // Only a same-origin navigation reaches this: page JS cannot set
  // Sec-Fetch-Site, and it is absent from nothing a browser sends. Blocking
  // it here is what stops a third-party site from top-level-navigating a
  // visitor straight into a scope grant for a package it chose.
  if (c.req.header("Sec-Fetch-Site") !== "same-origin") {
    return jsonResponse(c, 403, { ok: false, error: "This route only accepts a same-origin navigation" });
  }

  const scope = parseAndValidateScope(c.req.query("scope") || "");
  if (!scope) {
    return jsonResponse(c, 403, {
      ok: false,
      error: "scope must be a non-empty, space-separated list of known Cloudflare OAuth scopes",
    });
  }

  const pkg = c.req.query("pkg") || "";
  if (!isValidPackageHash(pkg)) {
    return jsonResponse(c, 403, { ok: false, error: "pkg must be the package's 64-character hex sha256" });
  }

  const nonce = generateStateNonce();
  const stateHash = await hashStateNonce(nonce, c.env.OAUTH_STATE_SECRET);
  const cookieValue = await signStateCookie({ stateHash, scope, pkg, iat: now() }, c.env.OAUTH_STATE_SECRET);

  const target = new URL(CF_AUTHORIZE_URL);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", c.env.OAUTH_CLIENT_ID);
  target.searchParams.set("redirect_uri", c.env.OAUTH_REDIRECT_URI);
  target.searchParams.set("scope", formatScopeParam(scope));
  target.searchParams.set("state", nonce);

  const headers = new Headers({ Location: target.toString() });
  headers.append(
    "Set-Cookie",
    serializeCookie(OV_STATE_COOKIE, cookieValue, {
      ...STATE_COOKIE_OPTS,
      maxAgeSeconds: STATE_COOKIE_MAX_AGE_SECONDS,
    }),
  );
  return new Response(null, { status: 302, headers });
}

const FAILURE = {
  denied: "Cloudflare sign-in was not completed.",
  noState: "Your sign-in session expired or was already used. Go back and try connecting to Cloudflare again.",
  badState: "This sign-in attempt could not be verified. Go back and try connecting to Cloudflare again.",
  tokenExchange: "Could not complete sign-in with Cloudflare. Go back and try again.",
  accounts: "Signed in, but could not read your Cloudflare account list. Go back and try again.",
} as const;

function callbackHeaders(): Headers {
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
}

function failurePage(message: string, clearStateCookie: string): Response {
  const headers = callbackHeaders();
  headers.append("Set-Cookie", clearStateCookie);
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Overture</title></head>` +
    `<body><p>${message}</p><p>You can close this window.</p></body></html>`;
  return new Response(body, { status: 200, headers });
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface AccountsEnvelope {
  success?: boolean;
  result?: Array<{ id?: string; name?: string }>;
}

// GET /oauth/callback — Cloudflare redirects here with ?code&state (or ?error
// if the user declined). Everything from state verification through the
// account list has to happen in this one request: the authorization code is
// short-lived enough that any intermediate UI step invalidates it.
export async function handleOauthCallback(c: RelayContext): Promise<Response> {
  const clearState = expireCookie(OV_STATE_COOKIE, STATE_COOKIE_OPTS);
  const url = new URL(c.req.url);

  if (url.searchParams.get("error")) {
    return failurePage(FAILURE.denied, clearState);
  }

  const stateCookie = parseCookies(c.req.header("Cookie"))[OV_STATE_COOKIE];
  if (!stateCookie) {
    return failurePage(FAILURE.noState, clearState);
  }

  const statePayload = await verifyStateCookie(stateCookie, c.env.OAUTH_STATE_SECRET);
  if (!statePayload) {
    return failurePage(FAILURE.badState, clearState);
  }

  const nonce = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  if (!code || !(await stateNonceMatches(nonce, statePayload.stateHash, c.env.OAUTH_STATE_SECRET))) {
    return failurePage(FAILURE.badState, clearState);
  }

  let token: TokenResponse;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: c.env.OAUTH_REDIRECT_URI,
    });
    const tokenRes = await fetch(CF_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth(c.env.OAUTH_CLIENT_ID, c.env.OAUTH_CLIENT_SECRET)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!tokenRes.ok) throw new Error("token exchange failed");
    token = (await tokenRes.json()) as TokenResponse;
    if (!token.access_token) throw new Error("no access_token in response");
  } catch {
    return failurePage(FAILURE.tokenExchange, clearState);
  }

  let accounts: SessionAccount[];
  try {
    const accountsRes = await fetch(CF_ACCOUNTS_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const envelope = (await accountsRes.json()) as AccountsEnvelope;
    if (!accountsRes.ok || !envelope.success || !Array.isArray(envelope.result)) {
      throw new Error("accounts fetch failed");
    }
    accounts = envelope.result
      .filter((a): a is { id: string; name: string } => typeof a.id === "string" && typeof a.name === "string")
      .map((a) => ({ id: a.id, name: a.name }));
  } catch {
    return failurePage(FAILURE.accounts, clearState);
  }

  const expiresIn = Number.isFinite(token.expires_in) && (token.expires_in as number) > 0 ? (token.expires_in as number) : 3600;
  const expiresAt = now() + expiresIn;
  // Prefer what Cloudflare actually granted; fall back to what was requested
  // if that string is somehow malformed, since either was already validated
  // against the same known-scope directory.
  const grantedScope = parseAndValidateScope(token.scope || "") ?? statePayload.scope;

  const sessionCookieValue = await encryptSession(
    { token: token.access_token, scope: grantedScope, accounts, pkg: statePayload.pkg, expiresAt },
    c.env.OAUTH_SESSION_KEY,
  );

  const headers = callbackHeaders();
  headers.append("Set-Cookie", clearState);
  headers.append(
    "Set-Cookie",
    serializeCookie(OV_SESSION_COOKIE, sessionCookieValue, { ...SESSION_COOKIE_OPTS, maxAgeSeconds: expiresIn }),
  );

  // No token, scope, or account data leaves this response — the opener reads
  // all of that back through GET /oauth/session, which never echoes the
  // token, once it hears this signal.
  const body =
    `<!doctype html><html><head><meta charset="utf-8"><title>Overture</title></head><body><script>` +
    `if (window.opener) { window.opener.postMessage("oauth:complete", window.location.origin); }` +
    `window.close();` +
    `</script><p>You can close this window.</p></body></html>`;
  return new Response(body, { status: 200, headers });
}

function sessionResponseBody(session: {
  scope: string[];
  accounts: SessionAccount[];
  accountId?: string;
  pkg: string;
  expiresAt: number;
}) {
  return {
    authorized: true,
    scope: session.scope,
    accounts: session.accounts,
    accountId: session.accountId,
    pkg: session.pkg,
    expiresAt: session.expiresAt,
  };
}

async function readSession(c: RelayContext) {
  const cookie = parseCookies(c.req.header("Cookie"))[OV_SESSION_COOKIE];
  if (!cookie) return null;
  const session = await decryptSession(cookie, c.env.OAUTH_SESSION_KEY);
  if (!session || session.expiresAt <= now()) return null;
  return session;
}

// GET /oauth/session — read-only session status. Never returns the token.
export async function handleOauthSessionGet(c: RelayContext): Promise<Response> {
  const session = await readSession(c);
  if (!session) return jsonResponse(c, 200, { authorized: false });
  return jsonResponse(c, 200, sessionResponseBody(session));
}

// POST /oauth/session { accountId } — records which of the already-authorized
// accounts the deployment targets. Re-signs the cookie; does not touch Cloudflare.
export async function handleOauthSessionPost(c: RelayContext): Promise<Response> {
  const contentType = (c.req.header("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return jsonResponse(c, 400, { ok: false, error: "Expected Content-Type: application/json" });
  }

  const session = await readSession(c);
  if (!session) {
    return jsonResponse(c, 403, { ok: false, error: "Not signed in" });
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonResponse(c, 400, { ok: false, error: "Invalid JSON body" });
  }
  const accountId = body && typeof body === "object" && typeof (body as Record<string, unknown>).accountId === "string"
    ? ((body as Record<string, unknown>).accountId as string)
    : "";
  if (!session.accounts.some((a) => a.id === accountId)) {
    return jsonResponse(c, 403, { ok: false, error: "accountId is not one of this session's authorized accounts" });
  }

  const updated = { ...session, accountId };
  const cookieValue = await encryptSession(updated, c.env.OAUTH_SESSION_KEY);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    serializeCookie(OV_SESSION_COOKIE, cookieValue, { ...SESSION_COOKIE_OPTS, maxAgeSeconds: updated.expiresAt - now() }),
  );
  return new Response(JSON.stringify(sessionResponseBody(updated)), { status: 200, headers });
}

// POST /oauth/revoke — best-effort upstream revoke, unconditional local clear.
export async function handleOauthRevoke(c: RelayContext): Promise<Response> {
  const session = await readSession(c);
  if (session) {
    try {
      await fetch(CF_REVOKE_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth(c.env.OAUTH_CLIENT_ID, c.env.OAUTH_CLIENT_SECRET)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token_type_hint: "access_token", token: session.token }).toString(),
      });
    } catch {
      // The local cookie clears regardless — see the function comment above.
    }
  }

  const headers = new Headers();
  headers.append("Set-Cookie", expireCookie(OV_SESSION_COOKIE, SESSION_COOKIE_OPTS));
  return new Response(null, { status: 204, headers });
}
