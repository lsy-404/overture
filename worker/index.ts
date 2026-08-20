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

//
// Overture's backend: the same Worker that serves the built wizard through the
// ASSETS binding (Cloudflare matches the asset manifest first, so only unmatched
// paths reach this script) plus the routes the wizard cannot make from the
// browser itself:
//   GET  /oauth/authorize      starts the Cloudflare consent flow
//   GET  /oauth/callback       exchanges the code, writes the session cookie
//   /oauth/session             read (GET) or pick an account for (POST) the session
//   POST /oauth/revoke         upstream revoke + unconditional local cookie clear
//   /cf/*                      allow-listed passthrough to api.cloudflare.com
//   POST /r2/verify-keys       signed probe against R2's S3 endpoint
//   GET  /github/release-asset policy-checked package download
//   GET  /policy                read-only view of the operator's source allowlist
// CONTRACT.md is the spec. Never log Authorization headers, cookies,
// request/response bodies, or the R2 key pair: the trust model rests on this
// Worker being a pipe nobody can extract a credential from. There is no
// persistence and no admin token — everything the Worker knows comes from its
// own vars and secrets. The SPA and this Worker are always the same origin,
// so there is no CORS layer: every route that touches the session cookie sits
// behind csrfGate instead.
//

import { Hono } from "hono";
import { handleCfProxy } from "./cfProxy";
import { csrfGate } from "./csrf";
import { handleGithubAsset } from "./githubAsset";
import { jsonResponse } from "./http";
import { handleOauthAuthorize, handleOauthCallback, handleOauthRevoke, handleOauthSessionGet, handleOauthSessionPost } from "./oauthHandlers";
import { handleGetPolicy } from "./policy";
import { handleVerifyR2Keys } from "./r2Verify";

const app = new Hono<{ Bindings: Env }>();

// csrfGate covers every route that reads or writes ov_session, GET included.
// /oauth/authorize and /oauth/callback are deliberately outside it: they are
// reached by navigation (window.open / Cloudflare's own redirect), which
// cannot carry the custom header this gate requires — they have their own
// checks instead (Sec-Fetch-Site, then state verification).
app.use("/cf/*", csrfGate);
app.use("/oauth/session", csrfGate);
app.use("/oauth/revoke", csrfGate);
app.use("/r2/verify-keys", csrfGate);

app.all("/cf/*", handleCfProxy);
app.get("/oauth/authorize", handleOauthAuthorize);
app.get("/oauth/callback", handleOauthCallback);
app.get("/oauth/session", handleOauthSessionGet);
app.post("/oauth/session", handleOauthSessionPost);
app.post("/oauth/revoke", handleOauthRevoke);
app.post("/r2/verify-keys", handleVerifyR2Keys);
app.get("/github/release-asset", handleGithubAsset);
app.get("/policy", handleGetPolicy);

function wantsHtml(req: Request): boolean {
  return req.method === "GET" && (req.headers.get("Accept") || "").includes("text/html");
}

// Reaching here means neither a static asset nor an API route matched. The
// wizard is a single-page app with client-side routes (/settings), so a document
// request falls back to index.html and lets the router take over.
app.notFound(async (c) => {
  if (c.env.ASSETS) {
    const direct = await c.env.ASSETS.fetch(c.req.raw);
    if (direct.status !== 404 || !wantsHtml(c.req.raw)) return direct;
    const shell = new URL("/index.html", c.req.url);
    return c.env.ASSETS.fetch(new Request(shell, { headers: c.req.raw.headers }));
  }
  return jsonResponse(c, 404, { ok: false, error: "Not found" });
});

export default app;
