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

// POST /auth/token accepts a Cloudflare API token the visitor pasted in
// (auto: expected to carry Account API Tokens Write; manual: already narrow)
// and — after verifying it against Cloudflare itself, never trusting its
// shape alone — seals it into the same __Host-ov_session cookie the OAuth
// callback fills, so worker/cfProxy.ts injects it into /cf/* exactly the same
// way regardless of mode. POST /auth/token/revoke-self ends an auto-mode
// session by deleting the pasted token with itself as bearer; the deploy
// orchestrator calls it once the minted application token (worker/mintToken.ts)
// is already written into the app's own Secret, never before, since that PUT
// is itself authorized by this same session.

import type { Context } from "hono";
import { expireCookie, isValidPackageHash, sessionView, type SessionPayload } from "./oauth";
import { OV_SESSION_COOKIE, readSession, sealSessionCookie, SESSION_COOKIE_OPTS } from "./session";
import { jsonResponse } from "./http";
import { BodyTooLargeError, MAX_BODY_BYTES, readBodyWithLimit } from "./limits";
import { listAccountsForToken, selfDeleteAccountToken, verifyAccountToken } from "./cfTokens";

type RelayContext = Context<{ Bindings: Env }>;

// A pasted token's own Cloudflare-side lifetime is usually open-ended, but the
// cookie carrying it stays bounded the same way an OAuth session is when
// Cloudflare's token response omits expires_in (oauthHandlers.ts's own fallback).
const TOKEN_SESSION_MAX_AGE_SECONDS = 3600;
const MAX_TOKEN_CHARS = 4096;

const FAILURE = {
  invalidToken: "Could not verify this token with Cloudflare. Check that it is active and try again.",
  selfDeleteFailed: "Could not automatically revoke this token. Delete it from your Cloudflare dashboard.",
} as const;

interface AuthTokenRequest {
  token: string;
  mode: "auto" | "manual";
  pkg: string;
}

// Not a signature check — Cloudflare's own verify call is what actually
// authenticates this string. This only rejects what could never be a bearer
// token value in the first place.
function isPlausibleToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_CHARS && !/\s/.test(value);
}

function isAuthTokenRequest(body: unknown): body is AuthTokenRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return isPlausibleToken(b.token) && (b.mode === "auto" || b.mode === "manual") && typeof b.pkg === "string";
}

export async function handleAuthToken(c: RelayContext): Promise<Response> {
  if (!(c.req.header("Content-Type") || "").toLowerCase().includes("application/json")) {
    return jsonResponse(c, 400, { ok: false, error: "Expected Content-Type: application/json" });
  }

  let raw: ArrayBuffer;
  try {
    raw = await readBodyWithLimit(c.req.raw, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return jsonResponse(c, 413, { ok: false, error: "Request body too large" });
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonResponse(c, 400, { ok: false, error: "Invalid JSON body" });
  }

  if (!isAuthTokenRequest(parsed)) {
    return jsonResponse(c, 400, { ok: false, error: "Expected { token, mode, pkg }" });
  }
  const { token, mode, pkg } = parsed;

  if (!isValidPackageHash(pkg)) {
    return jsonResponse(c, 400, { ok: false, error: "pkg must be the package's 64-character hex sha256" });
  }

  // GET /accounts both proves the token is live and supplies the account list
  // the session needs — the same list shape the OAuth callback stores.
  const accounts = await listAccountsForToken(token);
  if (!accounts || accounts.length === 0) {
    return jsonResponse(c, 403, { ok: false, error: FAILURE.invalidToken });
  }

  // Account API Tokens verify per-account; the first account this token can
  // see is enough to confirm it is active — such a token is bound to the one
  // account it was minted on.
  const verified = await verifyAccountToken(token, accounts[0].id);
  if (!verified) {
    return jsonResponse(c, 403, { ok: false, error: FAILURE.invalidToken });
  }

  const session: SessionPayload = {
    token,
    scope: [],
    accounts,
    pkg,
    expiresAt: Math.floor(Date.now() / 1000) + TOKEN_SESSION_MAX_AGE_SECONDS,
    mode,
  };

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", await sealSessionCookie(session, c.env.OAUTH_COOKIE_KEY));
  return new Response(JSON.stringify(sessionView(session)), { status: 200, headers });
}

// POST /auth/token/revoke-self — only ever meaningful in auto mode: manual's
// token is the user's own, and oauth has no Account API Token to delete.
export async function handleRevokeSelf(c: RelayContext): Promise<Response> {
  const session = await readSession(c);
  if (!session || session.mode !== "auto") {
    return jsonResponse(c, 403, { ok: false, error: "Self-revoke is only available for the automatic authentication mode" });
  }

  const accountId = session.accountId ?? session.accounts[0]?.id;
  const deleted = accountId ? await selfDeleteAccountToken(session.token, accountId) : false;

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", expireCookie(OV_SESSION_COOKIE, SESSION_COOKIE_OPTS));
  if (!deleted) {
    // Not silent: the powerful token is still live in the visitor's Cloudflare
    // account, and this Worker keeps no record to retry the deletion with.
    return new Response(JSON.stringify({ ok: false, error: FAILURE.selfDeleteFailed }), { status: 200, headers });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
