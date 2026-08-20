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

import type { Context } from "hono";
import { matchEndpoint } from "../shared/cfAllowlist";
import { jsonResponse } from "./http";
import { BodyTooLargeError, MAX_BODY_BYTES, readBodyWithLimit } from "./limits";
import { decryptSession, parseCookies } from "./oauth";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const OV_SESSION_COOKIE = "__Host-ov_session";

// Never forward these upstream. Host/Content-Length describe the inbound hop,
// cf-*/x-forwarded-* describe the hop to this relay, and Cookie/Origin/
// Overture-Relay are this Worker's own session and CSRF plumbing — none of
// them mean anything to api.cloudflare.com. Authorization is excluded too:
// the caller's own header is never trusted (see below), it is set back in
// deliberately only for the one passthroughAuth endpoint.
const EXCLUDED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "authorization",
  "cookie",
  "origin",
  "overture-relay",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
]);

function buildForwardHeaders(req: Request): Headers {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!EXCLUDED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

// A loose but real shape check, not a signature check: this only has to catch
// "missing" and "obviously not a bearer token", not validate the JWT itself —
// Cloudflare's own asset-upload endpoint does that.
const BEARER_RE = /^Bearer\s+\S+$/;

type RelayContext = Context<{ Bindings: Env }>;

export async function handleCfProxy(c: RelayContext): Promise<Response> {
  const url = new URL(c.req.url);
  // url.pathname keeps "%2F" un-decoded, so what matchEndpoint sees is exactly
  // what gets forwarded — nothing can be re-decoded into an extra segment.
  const upstreamPath = url.pathname.slice(3); // drop "/cf", keep the rest's leading "/"
  const segments = upstreamPath.split("/").filter(Boolean);
  const method = c.req.method.toUpperCase();

  const rule = matchEndpoint(method, segments);
  if (!rule) {
    return jsonResponse(c, 403, { ok: false, error: "Endpoint is not allow-listed" });
  }

  const headers = buildForwardHeaders(c.req.raw);

  if (rule.passthroughAuth) {
    // This one entry never reads the session cookie, and there is no
    // fallback between the two auth sources: mixing them would either let a
    // caller steal the session token's use on this endpoint, or turn this
    // route into a free authenticated relay to api.cloudflare.com for anyone
    // who supplies their own bearer.
    const callerAuth = c.req.header("Authorization");
    if (!callerAuth || !BEARER_RE.test(callerAuth)) {
      return jsonResponse(c, 400, { ok: false, error: "Missing or malformed Authorization header" });
    }
    headers.set("Authorization", callerAuth);
  } else {
    const sessionCookie = parseCookies(c.req.header("Cookie"))[OV_SESSION_COOKIE];
    const session = sessionCookie ? await decryptSession(sessionCookie, c.env.OAUTH_SESSION_KEY) : null;
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
      return jsonResponse(c, 403, { ok: false, error: "Not signed in" });
    }
    // An `accounts/{id}` call must name the one account this session
    // selected — OAuth consent is a multi-account checkbox list, so without
    // this a package could read or write any account the grant covered, not
    // just the one the user picked. `/zones` has no account segment and
    // relies on the token's own authorization surface instead.
    if (segments[0] === "accounts" && (!session.accountId || segments[1] !== session.accountId)) {
      return jsonResponse(c, 403, { ok: false, error: "This account was not selected in the current session" });
    }
    headers.set("Authorization", `Bearer ${session.token}`);
  }

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    try {
      init.body = await readBodyWithLimit(c.req.raw, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        return jsonResponse(c, 413, { ok: false, error: "Request body too large" });
      }
      throw e;
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${CF_API_BASE}${upstreamPath}${url.search}`, init);
  } catch {
    return jsonResponse(c, 502, { ok: false, error: "Upstream Cloudflare API request failed" });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}
