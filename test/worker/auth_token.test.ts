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

// worker/authToken.ts's POST /auth/token, exercised through the real app so
// csrfGate and route registration (worker/index.ts) are covered along with
// the handler: verify a pasted token against Cloudflare, then seal it into
// the unified session cookie. global.fetch is stubbed per Cloudflare endpoint
// so nothing here reaches a real account.

import app from "../../worker/index";
import { decryptSession } from "../../worker/oauth";

const ENV = {
  OAUTH_CLIENT_ID: "test-client-id",
  OAUTH_REDIRECT_URI: "https://relay.example/oauth/callback",
  OAUTH_COOKIE_KEY: "auth-token-test-cookie-key",
} as unknown as Env;

const SELF_ORIGIN = "https://relay.example";
const RELAY_HEADERS = { "Overture-Relay": "1", Origin: SELF_ORIGIN };
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const OWN_TOKEN_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PKG = "a".repeat(64);

interface Route {
  status: number;
  body: unknown;
}
let routes: Map<string, Route> = new Map();
let fetchCalls: string[] = [];

function stubRoutes(table: Record<string, Route>): void {
  routes = new Map(Object.entries(table));
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push(`${init?.method || "GET"} ${url}`);
    for (const [suffix, route] of routes) {
      if (url.endsWith(suffix)) {
        return new Response(JSON.stringify(route.body), { status: route.status, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }) as typeof fetch;
}

const ACTIVE_TOKEN_ROUTES: Record<string, Route> = {
  "/accounts": { status: 200, body: { success: true, result: [{ id: ACCOUNT_ID, name: "Test Account" }] } },
  "/tokens/verify": { status: 200, body: { success: true, result: { id: OWN_TOKEN_ID, status: "active" } } },
};

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`${SELF_ORIGIN}${path}`, init, ENV);
}

function setCookieValue(res: Response): string {
  const raw = res.headers.get("Set-Cookie") || "";
  const match = raw.match(/__Host-ov_session=([^;]*)/);
  return match ? match[1] : "";
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  // --- csrfGate actually covers /auth/token (registration, not gate logic) ---
  stubRoutes(ACTIVE_TOKEN_ROUTES);
  const noRelayHeader = await call("/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SELF_ORIGIN },
    body: JSON.stringify({ token: "cfat_abc", mode: "auto", pkg: PKG }),
  });
  checks.push(["POST /auth/token without Overture-Relay is rejected with 403", noRelayHeader.status === 403]);
  checks.push(["a csrf rejection never calls Cloudflare", fetchCalls.length === 0]);

  // --- content-type and shape validation, before any fetch happens ---
  stubRoutes(ACTIVE_TOKEN_ROUTES);
  const noContentType = await call("/auth/token", { method: "POST", headers: RELAY_HEADERS, body: "{}" });
  checks.push(["a non-JSON Content-Type is rejected with 400", noContentType.status === 400]);

  stubRoutes(ACTIVE_TOKEN_ROUTES);
  const badMode = await call("/auth/token", {
    method: "POST",
    headers: { ...RELAY_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "cfat_abc", mode: "oauth", pkg: PKG }),
  });
  checks.push(['mode "oauth" is rejected on this route with 400 — oauth only ever comes from the callback', badMode.status === 400]);

  stubRoutes(ACTIVE_TOKEN_ROUTES);
  const manualMode = await call("/auth/token", {
    method: "POST",
    headers: { ...RELAY_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "cfat_abc", mode: "manual", pkg: PKG }),
  });
  checks.push(['mode "manual" no longer exists — rejected with 400', manualMode.status === 400]);

  stubRoutes(ACTIVE_TOKEN_ROUTES);
  const missingMode = await call("/auth/token", {
    method: "POST",
    headers: { ...RELAY_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "cfat_abc", pkg: PKG }),
  });
  checks.push(["a missing mode is rejected with 400", missingMode.status === 400]);

  stubRoutes(ACTIVE_TOKEN_ROUTES);
  const badPkg = await call("/auth/token", {
    method: "POST",
    headers: { ...RELAY_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "cfat_abc", mode: "auto", pkg: "not-a-sha256" }),
  });
  checks.push(["an invalid pkg is rejected with 400", badPkg.status === 400]);

  stubRoutes(ACTIVE_TOKEN_ROUTES);
  const emptyToken = await call("/auth/token", {
    method: "POST",
    headers: { ...RELAY_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "", mode: "auto", pkg: PKG }),
  });
  checks.push(["an empty token is rejected with 400 before any Cloudflare call", emptyToken.status === 400 && fetchCalls.length === 0]);

  // --- invalid token: Cloudflare says no ---
  stubRoutes({ "/accounts": { status: 200, body: { success: false } } });
  const invalidToken = await call("/auth/token", {
    method: "POST",
    headers: { ...RELAY_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "cfat_invalid", mode: "auto", pkg: PKG }),
  });
  const invalidBody = (await invalidToken.json()) as { ok: boolean; error?: string };
  checks.push(["a token Cloudflare rejects at /accounts is refused with 403", invalidToken.status === 403 && invalidBody.ok === false]);
  checks.push(["the upstream failure never reaches the browser verbatim", invalidBody.error === "Could not verify this token with Cloudflare. Check that it is active and try again."]);
  checks.push(["a rejected token never gets a session cookie", !invalidToken.headers.get("Set-Cookie")]);

  stubRoutes({
    "/accounts": ACTIVE_TOKEN_ROUTES["/accounts"],
    "/tokens/verify": { status: 200, body: { success: true, result: { id: OWN_TOKEN_ID, status: "expired" } } },
  });
  const inactiveToken = await call("/auth/token", {
    method: "POST",
    headers: { ...RELAY_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "cfat_expired", mode: "auto", pkg: PKG }),
  });
  checks.push(["a token that verifies but is not active is refused with 403", inactiveToken.status === 403]);

  // --- the happy path: token verifies, session is sealed, and /oauth/session reads it back ---
  stubRoutes(ACTIVE_TOKEN_ROUTES);
  const accepted = await call("/auth/token", {
    method: "POST",
    headers: { ...RELAY_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "cfat_valid_powerful_token", mode: "auto", pkg: PKG }),
  });
  const acceptedBody = (await accepted.json()) as Record<string, unknown>;
  checks.push(["a token Cloudflare confirms active is accepted with 200", accepted.status === 200]);
  checks.push(["the response never contains the pasted token itself", JSON.stringify(acceptedBody).includes("cfat_valid_powerful_token") === false]);
  checks.push(['the response reports mode "auto"', acceptedBody.mode === "auto"]);
  checks.push(["the response reports authorized: true", acceptedBody.authorized === true]);
  checks.push(["the response carries the account list Cloudflare returned", Array.isArray(acceptedBody.accounts) && (acceptedBody.accounts as unknown[]).length === 1]);

  const cookie = setCookieValue(accepted);
  checks.push(["a session cookie was actually set", cookie.length > 0]);
  const decoded = await decryptSession(cookie, ENV.OAUTH_COOKIE_KEY);
  checks.push(["the sealed cookie decrypts to a session carrying the pasted token", decoded?.token === "cfat_valid_powerful_token"]);
  checks.push(['the sealed cookie carries mode "auto"', decoded?.mode === "auto"]);

  const readBack = await call("/oauth/session", { headers: { ...RELAY_HEADERS, Cookie: `__Host-ov_session=${cookie}` } });
  const readBackBody = (await readBack.json()) as Record<string, unknown>;
  checks.push(["GET /oauth/session reads the mode back from a token-filled session", readBackBody.mode === "auto"]);
  checks.push(["GET /oauth/session still never returns the token", !("token" in readBackBody)]);

  let failures = 0;
  for (const [label, passed, detail] of checks) {
    if (passed) console.log(`  PASS ${label}`);
    else {
      failures++;
      console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }
  console.log(`${checks.length - failures}/${checks.length} assertions passed`);
  if (failures > 0) {
    console.error(`${failures} FAILURE(S)`);
    process.exit(1);
  }
}

run();
