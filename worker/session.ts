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

// The one __Host-ov_session name, cookie options, and read/reseal logic every
// route shares, regardless of which of the two auth modes filled it:
// oauthHandlers.ts's callback, authToken.ts's paste-a-token route, and
// cfProxy.ts's /cf/* injection all read or write the exact same cookie.
// worker/oauth.ts holds the crypto; this file is what a route does with a
// Hono Context around it.

import type { Context } from "hono";
import { decryptSession, encryptSession, parseCookies, serializeCookie, type SessionPayload } from "./oauth";

type RelayContext = Context<{ Bindings: Env }>;

export const OV_SESSION_COOKIE = "__Host-ov_session";
export const SESSION_COOKIE_OPTS = { path: "/", sameSite: "Strict" as const };

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Reads, decrypts, and freshness-checks the session cookie. Null on anything wrong — never throws. */
export async function readSession(c: RelayContext): Promise<SessionPayload | null> {
  const cookie = parseCookies(c.req.header("Cookie"))[OV_SESSION_COOKIE];
  if (!cookie) return null;
  const session = await decryptSession(cookie, c.env.OAUTH_COOKIE_KEY);
  if (!session || session.expiresAt <= now()) return null;
  return session;
}

/** `Set-Cookie` value sealing `session` under the standard session cookie options, aged to its own expiry. */
export async function sealSessionCookie(session: SessionPayload, secret: string): Promise<string> {
  const value = await encryptSession(session, secret);
  return serializeCookie(OV_SESSION_COOKIE, value, {
    ...SESSION_COOKIE_OPTS,
    maxAgeSeconds: Math.max(0, session.expiresAt - now()),
  });
}
