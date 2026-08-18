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
import { isPathAllowed } from "./cfAllowlist";
import { applyCorsHeaders, jsonResponse } from "./cors";
import { BodyTooLargeError, MAX_BODY_BYTES, readBodyWithLimit } from "./limits";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// Never forward these upstream: Host would target the wrong origin,
// Content-Length is recomputed once the body is buffered, and the cf-*/
// x-forwarded-* entries describe the inbound hop to this relay.
const EXCLUDED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
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

type RelayContext = Context<{ Bindings: Env }>;

export async function handleCfProxy(c: RelayContext): Promise<Response> {
  const url = new URL(c.req.url);
  // url.pathname keeps "%2F" un-decoded, so what isPathAllowed sees is exactly
  // what gets forwarded — nothing can be re-decoded into an extra segment.
  const upstreamPath = url.pathname.slice(3); // drop "/cf", keep the rest's leading "/"
  const segments = upstreamPath.split("/").filter(Boolean);
  const method = c.req.method.toUpperCase();

  if (!isPathAllowed(method, segments)) {
    return jsonResponse(c, 403, { ok: false, error: "Endpoint is not allow-listed" });
  }

  const init: RequestInit = {
    method,
    headers: buildForwardHeaders(c.req.raw),
  };
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

  const responseHeaders = new Headers(upstream.headers);
  applyCorsHeaders(c, responseHeaders);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
