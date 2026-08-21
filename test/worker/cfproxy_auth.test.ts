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

// worker/cfProxy.ts's two auth paths: the ov_session-backed default (the
// selected account must match the accounts/{id} segment; a caller-supplied
// Authorization is never trusted) and the passthroughAuth exception on
// worker.assetUpload (never reads the cookie; a missing or malformed caller
// Authorization is refused outright). global.fetch is stubbed so nothing here
// reaches a real Cloudflare account.

import { Hono } from "hono";
import { handleCfProxy } from "../../worker/cfProxy";
import { encryptSession, type SessionPayload } from "../../worker/oauth";

const SESSION_KEY = "cfproxy-test-session-key";
const ACCOUNT_A = "0123456789abcdef0123456789abcdef";
const ACCOUNT_B = "fedcba9876543210fedcba9876543210";

const env = { OAUTH_COOKIE_KEY: SESSION_KEY } as Env;

const app = new Hono<{ Bindings: Env }>();
app.all("/cf/*", handleCfProxy);

interface CapturedFetch {
  url: string;
  init: RequestInit;
}
let lastFetch: CapturedFetch | null = null;

function stubFetch(status = 200, body: unknown = { success: true, result: {} }): void {
  lastFetch = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastFetch = { url: String(input), init: init || {} };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function forwardedAuth(): string | null {
  return lastFetch ? new Headers(lastFetch.init.headers).get("Authorization") : null;
}

async function call(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
  return app.fetch(new Request(`https://relay.example${path}`, { method, headers }), env);
}

async function sessionCookie(overrides: Partial<SessionPayload> = {}): Promise<string> {
  const full: SessionPayload = {
    token: "cfoat_session_token",
    scope: ["d1.read"],
    accounts: [
      { id: ACCOUNT_A, name: "A" },
      { id: ACCOUNT_B, name: "B" },
    ],
    pkg: "a".repeat(64),
    expiresAt: Math.floor(Date.now() / 1000) + 3599,
    mode: "oauth",
    ...overrides,
  };
  return `__Host-ov_session=${await encryptSession(full, SESSION_KEY)}`;
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  // --- passthroughAuth: worker.assetUpload never reads the cookie ---
  stubFetch();
  const noAuth = await call(`/cf/accounts/${ACCOUNT_A}/workers/assets/upload`, {}, "POST");
  checks.push(["passthroughAuth endpoint rejects a missing Authorization header with 400", noAuth.status === 400]);

  stubFetch();
  const malformedAuth = await call(`/cf/accounts/${ACCOUNT_A}/workers/assets/upload`, { Authorization: "Bearer" }, "POST");
  checks.push(["passthroughAuth endpoint rejects a malformed Authorization header with 400", malformedAuth.status === 400]);

  stubFetch();
  const passthroughOk = await call(
    `/cf/accounts/${ACCOUNT_A}/workers/assets/upload`,
    { Authorization: "Bearer caller-jwt-value", Cookie: await sessionCookie({ accountId: ACCOUNT_A }) },
    "POST",
  );
  checks.push(["passthroughAuth endpoint accepts a well-formed caller Authorization", passthroughOk.status === 200]);
  checks.push([
    "passthroughAuth endpoint forwards the caller's own token, not the session's, even though a valid session cookie was also sent",
    forwardedAuth() === "Bearer caller-jwt-value",
  ]);

  // --- session-backed endpoints: default path ---
  stubFetch();
  const noSession = await call(`/cf/accounts/${ACCOUNT_A}/workers/scripts`);
  checks.push(["a session-backed endpoint with no ov_session cookie is rejected with 403", noSession.status === 403]);

  stubFetch();
  const noAccountSelected = await call(`/cf/accounts/${ACCOUNT_A}/workers/scripts`, { Cookie: await sessionCookie() });
  checks.push(["an accounts/{id} call with no accountId selected in the session is rejected with 403", noAccountSelected.status === 403]);

  stubFetch();
  const wrongAccount = await call(`/cf/accounts/${ACCOUNT_A}/workers/scripts`, {
    Cookie: await sessionCookie({ accountId: ACCOUNT_B }),
  });
  checks.push(["an accounts/{id} call for an account other than the one selected is rejected with 403", wrongAccount.status === 403]);

  stubFetch();
  const matchingAccount = await call(`/cf/accounts/${ACCOUNT_A}/workers/scripts`, {
    Cookie: await sessionCookie({ accountId: ACCOUNT_A }),
  });
  checks.push(["an accounts/{id} call matching the selected account is forwarded", matchingAccount.status === 200]);
  checks.push(["the forwarded call carries the session's own token", forwardedAuth() === "Bearer cfoat_session_token"]);

  stubFetch();
  await call(`/cf/accounts/${ACCOUNT_A}/workers/scripts`, {
    Cookie: await sessionCookie({ accountId: ACCOUNT_A }),
    Authorization: "Bearer attacker-supplied-token",
  });
  checks.push([
    "a caller-supplied Authorization header is never forwarded on a session-backed endpoint",
    forwardedAuth() === "Bearer cfoat_session_token",
  ]);

  // --- mode-agnostic: auto and manual sessions get the same account-segment
  // binding as oauth, since cfProxy.ts injects session.token regardless of
  // how the session was filled ---
  for (const mode of ["auto", "manual"] as const) {
    stubFetch();
    const wrongAccountForMode = await call(`/cf/accounts/${ACCOUNT_A}/workers/scripts`, {
      Cookie: await sessionCookie({ accountId: ACCOUNT_B, mode }),
    });
    checks.push([`a ${mode}-mode session for another account is rejected with 403`, wrongAccountForMode.status === 403]);

    stubFetch();
    const matchingForMode = await call(`/cf/accounts/${ACCOUNT_A}/workers/scripts`, {
      Cookie: await sessionCookie({ accountId: ACCOUNT_A, mode, token: `${mode}-pasted-token` }),
    });
    checks.push([`a ${mode}-mode session matching the selected account is forwarded`, matchingForMode.status === 200]);
    checks.push([`the forwarded call carries the ${mode}-mode session's own token`, forwardedAuth() === `Bearer ${mode}-pasted-token`]);
  }

  // --- /zones has no accounts/{id} segment: no selected account required ---
  stubFetch();
  const zones = await call("/cf/zones", { Cookie: await sessionCookie() });
  checks.push(["a /zones call needs a session but not a selected account", zones.status === 200]);

  // --- internal headers never leak upstream ---
  stubFetch();
  await call("/cf/zones", { Cookie: await sessionCookie(), Origin: "https://relay.example", "Overture-Relay": "1" });
  const forwardedHeaders = lastFetch ? new Headers(lastFetch.init.headers) : new Headers();
  checks.push(["the session Cookie is never forwarded upstream", !forwardedHeaders.has("Cookie")]);
  checks.push(["Origin is never forwarded upstream", !forwardedHeaders.has("Origin")]);
  checks.push(["Overture-Relay is never forwarded upstream", !forwardedHeaders.has("Overture-Relay")]);

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
