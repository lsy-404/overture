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

// Pure functions only: no fetch, no Cloudflare calls, no Hono Context. Two
// cookies live here — ov_state (short-lived, HMAC-signed, carries the
// authorize request's identity across the redirect to Cloudflare and back)
// and ov_session (AES-GCM encrypted, carries the token nobody but this Worker
// may read). oauthHandlers.ts does the network calls and wires these into
// routes; keeping this file free of both makes the crypto and cookie shapes
// testable without a live Cloudflare account.

import { isKnownScope } from "../shared/oauthScopes";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 256 bits from the platform CSPRNG — the opaque nonce sent to Cloudflare as `state`. */
export function generateStateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// Both cookies are keyed off a Workers secret string, not a fixed-length key,
// so each is hashed down to exactly the 32 bytes HMAC-SHA256/AES-256-GCM need.
// The two secrets (OAUTH_STATE_SECRET, OAUTH_SESSION_KEY) are never shared, so
// a key derived from one cannot be replayed against the other's cookie.
async function deriveKeyBytes(secret: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", textEncoder.encode(secret));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await deriveKeyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await deriveKeyBytes(secret), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(data));
  return toBase64Url(new Uint8Array(signature));
}

// Both inputs are already base64url text of fixed, bounded size (a nonce hash
// or an HMAC digest), so length equality first is not a meaningful leak.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const STATE_COOKIE_MAX_AGE_SECONDS = 600;

export interface StatePayload {
  /** HMAC(OAUTH_STATE_SECRET, nonce) — binds this cookie to the nonce handed to Cloudflare. */
  stateHash: string;
  scope: string[];
  /** `recipe.package.sha256` — the package this authorize request was made for. */
  pkg: string;
  iat: number;
}

function isStatePayload(value: unknown): value is StatePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.stateHash === "string" &&
    Array.isArray(v.scope) &&
    v.scope.every((s) => typeof s === "string") &&
    typeof v.pkg === "string" &&
    typeof v.iat === "number"
  );
}

/** `HMAC(secret, nonce)`, stored in the state cookie so the raw nonce need not be. */
export async function hashStateNonce(nonce: string, secret: string): Promise<string> {
  return hmac(secret, nonce);
}

export async function stateNonceMatches(nonce: string, stateHash: string, secret: string): Promise<boolean> {
  return timingSafeEqual(await hashStateNonce(nonce, secret), stateHash);
}

/** Cookie value: base64url(JSON payload) + "." + HMAC of that text. */
export async function signStateCookie(payload: StatePayload, secret: string): Promise<string> {
  const body = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

/**
 * Verifies the signature and freshness of an ov_state cookie value. Does not
 * check the nonce itself — call `stateNonceMatches` against the callback's
 * `state` query parameter separately, since that comparison needs the value
 * Cloudflare sent back.
 */
export async function verifyStateCookie(cookieValue: string, secret: string): Promise<StatePayload | null> {
  const dot = cookieValue.indexOf(".");
  if (dot === -1) return null;
  const body = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!timingSafeEqual(await hmac(secret, body), signature)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(fromBase64Url(body)));
  } catch {
    return null;
  }
  if (!isStatePayload(parsed)) return null;
  if (Math.floor(Date.now() / 1000) - parsed.iat > STATE_COOKIE_MAX_AGE_SECONDS) return null;
  return parsed;
}

export interface SessionAccount {
  id: string;
  name: string;
}

export interface SessionPayload {
  token: string;
  scope: string[];
  accounts: SessionAccount[];
  accountId?: string;
  /** `recipe.package.sha256` this grant was obtained for. */
  pkg: string;
  /** Unix seconds — the access token's own expiry, not the cookie's. */
  expiresAt: number;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.token !== "string" ||
    !Array.isArray(v.scope) ||
    !v.scope.every((s) => typeof s === "string") ||
    !Array.isArray(v.accounts) ||
    typeof v.pkg !== "string" ||
    typeof v.expiresAt !== "number"
  ) {
    return false;
  }
  if (v.accountId !== undefined && typeof v.accountId !== "string") return false;
  return v.accounts.every(
    (a) => a && typeof a === "object" && typeof (a as SessionAccount).id === "string" && typeof (a as SessionAccount).name === "string",
  );
}

/** Cookie value: base64url(iv) + "." + base64url(AES-GCM ciphertext, tag included). */
export async function encryptSession(payload: SessionPayload, secret: string): Promise<string> {
  const key = await importAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(JSON.stringify(payload)));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Returns null for anything that fails to decrypt or does not parse as a `SessionPayload` — never throws. */
export async function decryptSession(cookieValue: string, secret: string): Promise<SessionPayload | null> {
  const dot = cookieValue.indexOf(".");
  if (dot === -1) return null;
  try {
    const key = await importAesKey(secret);
    const iv = fromBase64Url(cookieValue.slice(0, dot));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, fromBase64Url(cookieValue.slice(dot + 1)));
    const parsed: unknown = JSON.parse(textDecoder.decode(plaintext));
    return isSessionPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface CookieOptions {
  path: string;
  sameSite: "Strict" | "Lax";
  maxAgeSeconds?: number;
}

/**
 * `Set-Cookie` header value. Always HttpOnly + Secure — no cookie here is ever
 * meant to be read by a script. `name` should include the `__Host-` prefix
 * where the caller wants it; this function does not add or enforce one.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, `Path=${options.path}`, "HttpOnly", "Secure", `SameSite=${options.sameSite}`];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join("; ");
}

export function expireCookie(name: string, options: Pick<CookieOptions, "path" | "sameSite">): string {
  return serializeCookie(name, "", { ...options, maxAgeSeconds: 0 });
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Parses and validates a space-separated `scope` request parameter: rejects
 * empty input and anything outside `shared/oauthScopes.ts`'s known directory.
 * The result is sorted and de-duplicated so two equivalent requests compare
 * equal.
 */
export function parseAndValidateScope(raw: string): string[] | null {
  const scopes = [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (scopes.length === 0) return null;
  if (!scopes.every(isKnownScope)) return null;
  return scopes.sort();
}

const PACKAGE_HASH_RE = /^[0-9a-f]{64}$/i;

export function isValidPackageHash(value: string): boolean {
  return PACKAGE_HASH_RE.test(value);
}
