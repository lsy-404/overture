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

// Every Cloudflare call goes through this deployment's own Worker routes
// (`/cf/*`, `/r2/verify-keys`, `/github/release-asset`): api.cloudflare.com
// sends no CORS headers, so a direct browser call fails regardless of whether
// the session is valid. The relay allow-lists paths — an endpoint nobody
// listed on purpose is refused there, not here.
//
// This SPA never holds a Cloudflare credential: `/cf/*` authorizes every call
// from the `ov_session` HttpOnly cookie the OAuth callback wrote, which
// JavaScript here cannot read either way. `credentials: "same-origin"` is what
// carries that cookie; `Overture-Relay: 1` is what a form post or a cross-site
// `<img>` cannot forge, since neither can set a custom header. Both go on every
// call that touches the session, per the relay's CSRF gate.

import { sourceSlug, type SourceRef } from "../../shared/package";
import { formatScopeParam } from "../../shared/oauthScopes";
import type { AuthMode } from "./recipe/types";

/** Every call that reads or writes the session cookie carries this — the
 *  relay's second CSRF gate, alongside `SameSite` and the Origin check. */
const RELAY_HEADER = { "Overture-Relay": "1" } as const;

export class CfApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly context?: string,
  ) {
    super(message);
    this.name = "CfApiError";
  }
}

// Empty (the default) means same-origin relative calls — the Worker serves both
// the built frontend and these routes. Only set VITE_RELAY_URL when the frontend
// is deployed separately from the Worker it talks to.
function relayBase(): string {
  const url = (import.meta.env.VITE_RELAY_URL || "").trim();
  return url.replace(/\/+$/, "");
}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

// A network-level failure (relay unreachable, DNS, TLS, offline) surfaces from
// fetch() as a bare `TypeError: Failed to fetch` with no further detail. Naming
// the relay turns that dead end into something actionable.
async function fetchRelay(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    // A caller that walked away is not a relay that is down.
    if (init.signal?.aborted) throw error;
    throw new CfApiError(
      `Couldn't reach the deploy relay at ${url.replace(/\/(cf|r2|github)\/.*$/, "")} — check your connection or that the relay is deployed.`,
      0,
    );
  }
}

/**
 * Streams a release asset through the relay. `src` travels with the request
 * because the relay re-checks two things independently: that the URL really is
 * a release download of that repository, and that the repository passes the
 * operator's deploy policy.
 */
export async function fetchGithubReleaseAsset(url: string, ref: SourceRef, signal?: AbortSignal): Promise<Response> {
  const query = `src=${encodeURIComponent(sourceSlug(ref))}&url=${encodeURIComponent(url)}`;
  return fetchRelay(`${relayBase()}/github/release-asset?${query}`, {
    headers: { Accept: "application/octet-stream" },
    signal,
  });
}

/** Calls `/cf/<path>`, authorized by the `ov_session` cookie. */
export async function callCfJson<T>(path: string, init?: RequestInit, context?: string): Promise<T> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...RELAY_HEADER,
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  let body: CfEnvelope<T>;
  try {
    body = (await response.json()) as CfEnvelope<T>;
  } catch {
    throw new CfApiError(`Cloudflare returned a non-JSON response (HTTP ${response.status})`, response.status, undefined, context);
  }
  if (!response.ok || !body.success) {
    const first = body.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
  return body.result as T;
}

/** Script deletion answers with an empty body, which `response.json()` can't parse. */
export async function callCfNoContent(path: string, init?: RequestInit, context?: string): Promise<void> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...RELAY_HEADER,
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  const text = (await response.text()).trim();
  let body: CfEnvelope<unknown> | undefined;
  if (text) {
    try {
      body = JSON.parse(text) as CfEnvelope<unknown>;
    } catch {
      body = undefined;
    }
  }
  if (!response.ok || body?.success === false) {
    const first = body?.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
}

/** Multipart variant for the Worker version upload, authorized by the session cookie. */
export async function callCfMultipart<T>(path: string, form: FormData, context?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: RELAY_HEADER,
    body: form,
    signal,
  });
  let body: CfEnvelope<T>;
  try {
    body = (await response.json()) as CfEnvelope<T>;
  } catch {
    throw new CfApiError(`Cloudflare returned a non-JSON response (HTTP ${response.status})`, response.status, undefined, context);
  }
  if (!response.ok || !body.success) {
    const first = body.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
  return body.result as T;
}

/**
 * The one relay call the session cookie never authorizes: completing an asset
 * upload carries the short-lived JWT Cloudflare's own upload session issued,
 * which the relay's `passthroughAuth` rule forwards instead of reading
 * `ov_session` — the same exception `worker.assetUpload` names on the Worker
 * side. Nowhere else in this file sends an `Authorization` header.
 */
export async function callCfMultipartBearer<T>(
  bearerToken: string,
  path: string,
  form: FormData,
  context?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken}`, ...RELAY_HEADER },
    body: form,
    signal,
  });
  let body: CfEnvelope<T>;
  try {
    body = (await response.json()) as CfEnvelope<T>;
  } catch {
    throw new CfApiError(`Cloudflare returned a non-JSON response (HTTP ${response.status})`, response.status, undefined, context);
  }
  if (!response.ok || !body.success) {
    const first = body.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
  return body.result as T;
}

export interface R2VerifyParams {
  accountId: string;
  bucketName?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2VerifyResult {
  ok: boolean;
  status?: number;
  message?: string;
}

/** The relay signs a HEAD against R2 itself; this never touches api.cloudflare.com. */
export async function verifyR2Keys(params: R2VerifyParams): Promise<R2VerifyResult> {
  const base = relayBase();
  let response: Response;
  try {
    response = await fetch(`${base}/r2/verify-keys`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...RELAY_HEADER },
      body: JSON.stringify(params),
    });
  } catch {
    return { ok: false, message: `Couldn't reach the deploy relay at ${base} — check your connection or that the relay is deployed.` };
  }
  try {
    return (await response.json()) as R2VerifyResult;
  } catch {
    return { ok: false, status: response.status, message: "The relay returned a non-JSON response" };
  }
}

// ---------------------------------------------------------------------------
// OAuth session
// ---------------------------------------------------------------------------
//
// The SPA never sees a Cloudflare credential, only what these three routes
// choose to reveal about the `ov_session` cookie they read and write. The
// authorize step is a plain URL a click handler navigates a popup to — it is
// never `fetch`ed — because the callback that lands there sets the cookie via
// a real top-level navigation, which a fetch cannot do.

export interface OAuthAccount {
  id: string;
  name: string;
}

export interface OAuthSessionState {
  authorized: boolean;
  /** Every scope the consent screen actually granted. */
  scope: string[];
  /** Every account the grant covers; empty until authorized. */
  accounts: OAuthAccount[];
  /** The account this deployment will act as, once chosen. */
  accountId: string | null;
  /** `recipe.package.sha256` this session's scope was requested for. */
  pkg: string | null;
  /** Unix seconds the session cookie stops being honoured. */
  expiresAt: number | null;
  /** How this session was authorized. Absent from a pre-mode server treated as "oauth". */
  mode: AuthMode | null;
}

function parseOAuthSession(body: unknown): OAuthSessionState {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((entry) => ({ id: String(entry.id ?? "").trim(), name: String(entry.name ?? "") }))
        .filter((entry) => entry.id.length > 0)
    : [];
  const mode = raw.mode === "oauth" || raw.mode === "auto" ? raw.mode : null;
  return {
    authorized: raw.authorized === true,
    // The wire shape is an array (worker/oauthHandlers.ts sessionResponseBody).
    scope: Array.isArray(raw.scope) ? raw.scope.filter((entry): entry is string => typeof entry === "string") : [],
    accounts,
    accountId: typeof raw.accountId === "string" && raw.accountId ? raw.accountId : null,
    pkg: typeof raw.pkg === "string" && raw.pkg ? raw.pkg : null,
    expiresAt: typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
    mode,
  };
}

async function readOAuthSessionResponse(response: Response, fallback: string): Promise<OAuthSessionState> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CfApiError(`The relay returned a non-JSON response (HTTP ${response.status})`, response.status);
  }
  if (!response.ok) {
    const first = (body as { errors?: Array<{ code?: number; message?: string }> } | null)?.errors?.[0];
    throw new CfApiError(first?.message || `${fallback} (HTTP ${response.status})`, response.status, first?.code);
  }
  return parseOAuthSession(body);
}

/**
 * The URL the "Sign in with Cloudflare" button opens a popup to. Never
 * `fetch`ed here — `window.open(oauthAuthorizeUrl(...))` has to run inside the
 * button's own synchronous click handler, or the popup blocker wins.
 */
export function oauthAuthorizeUrl(scope: readonly string[], pkg: string): string {
  const query = `scope=${encodeURIComponent(formatScopeParam(scope))}&pkg=${encodeURIComponent(pkg)}`;
  return `${relayBase()}/oauth/authorize?${query}`;
}

/** Reads what the session cookie currently holds. Never returns a token. */
export async function fetchOAuthSession(): Promise<OAuthSessionState> {
  const response = await fetchRelay(`${relayBase()}/oauth/session`, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...RELAY_HEADER },
  });
  return readOAuthSessionResponse(response, "Couldn't read the sign-in session");
}

/** Picks which of the granted accounts this deployment acts as. */
export async function selectOAuthAccount(accountId: string): Promise<OAuthSessionState> {
  const response = await fetchRelay(`${relayBase()}/oauth/session`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...RELAY_HEADER },
    body: JSON.stringify({ accountId }),
  });
  return readOAuthSessionResponse(response, "Couldn't switch accounts");
}

/**
 * Ends the session: revokes the grant at Cloudflare and clears the cookie.
 * Best-effort — a session that fails to revoke still expires within the hour.
 * `keepalive` is for the one caller that fires this from `pagehide`, where
 * `sendBeacon` would be the usual choice except it cannot set a custom header,
 * and this call needs `Overture-Relay` like every other one that touches the
 * session cookie.
 */
export async function revokeOAuthSession(options?: { keepalive?: boolean }): Promise<void> {
  try {
    await fetch(`${relayBase()}/oauth/revoke`, {
      method: "POST",
      credentials: "same-origin",
      headers: RELAY_HEADER,
      keepalive: options?.keepalive === true,
    });
  } catch {
    // Nothing to recover to — the tab is closing or the relay is unreachable.
  }
}

/**
 * Posts a user-pasted Cloudflare API token to be verified and sealed into the
 * session cookie — the auto-mode counterpart to the OAuth popup flow. The
 * token itself is never returned; the reply is the same read-only session
 * shape `GET /oauth/session` gives back.
 */
export async function submitAuthToken(token: string, mode: "auto", pkg: string): Promise<OAuthSessionState> {
  const response = await fetchRelay(`${relayBase()}/auth/token`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...RELAY_HEADER },
    body: JSON.stringify({ token, mode, pkg }),
  });
  return readOAuthSessionResponse(response, "Couldn't verify that token");
}
