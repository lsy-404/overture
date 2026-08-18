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

// Release asset download host does not send CORS headers, so the bytes come
// through here. Two independent checks keep this from being an open fetcher: the
// URL has to be a release download of the repository named in `src`, and that
// repository has to pass the operator's deploy policy.

import type { Context } from "hono";
import { isReleaseAssetUrl, MAX_ARTIFACT_BYTES, parseSource } from "../shared/package";
import { isSourceAllowed, policyFromVars } from "../shared/policy";
import { applyCorsHeaders, jsonResponse } from "./cors";

type RelayContext = Context<{ Bindings: Env }>;

export async function handleGithubAsset(c: RelayContext): Promise<Response> {
  const ref = parseSource(c.req.query("src") || "");
  if (!ref) {
    return jsonResponse(c, 400, { ok: false, error: "Expected src=owner/repo" });
  }

  const url = c.req.query("url") || "";
  if (!isReleaseAssetUrl(url, ref)) {
    return jsonResponse(c, 400, {
      ok: false,
      error: "url must be a release download of the repository named in src",
    });
  }

  const policy = policyFromVars(c.env);
  if (!isSourceAllowed(policy, ref)) {
    return jsonResponse(c, 403, {
      ok: false,
      error: `This Overture deployment only serves packages from its allow-listed sources; ${ref.owner}/${ref.repo} is not one of them.`,
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  } catch {
    return jsonResponse(c, 502, { ok: false, error: "Unable to download the release asset" });
  }
  if (!upstream.ok || !upstream.body) {
    return jsonResponse(c, upstream.status || 502, {
      ok: false,
      error: "Release asset download failed",
    });
  }

  const length = Number(upstream.headers.get("content-length") || "0");
  if (length > MAX_ARTIFACT_BYTES) {
    return jsonResponse(c, 413, { ok: false, error: "Release asset is too large" });
  }

  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
  });
  if (length > 0) headers.set("Content-Length", String(length));
  applyCorsHeaders(c, headers);
  return new Response(upstream.body, { status: 200, headers });
}
