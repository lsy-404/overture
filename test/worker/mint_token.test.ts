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

// worker/mintToken.ts's POST /cf/mint-app-token, exercised through the real
// app so route precedence over the /cf/* wildcard (worker/index.ts) and
// csrfGate coverage are proven along with the handler: only an auto-mode
// session may mint, the account segment must match the session's selected
// account, and the powerful session token must never appear in the response —
// only the freshly minted, narrow token value may.

import app from "../../worker/index";
import { encryptSession, type SessionPayload } from "../../worker/oauth";

const ENV = {
  OAUTH_CLIENT_ID: "test-client-id",
  OAUTH_REDIRECT_URI: "https://relay.example/oauth/callback",
  OAUTH_COOKIE_KEY: "mint-token-test-cookie-key",
} as unknown as Env;

const SELF_ORIGIN = "https://relay.example";
const RELAY_HEADERS = { "Overture-Relay": "1", Origin: SELF_ORIGIN, "Content-Type": "application/json" };
const ACCOUNT_A = "0123456789abcdef0123456789abcdef";
const ACCOUNT_B = "fedcba9876543210fedcba9876543210";
const POWERFUL_TOKEN = "cfat_powerful_session_token";
const MINTED_TOKEN = "cfat_freshly_minted_narrow_token";

let fetchCalls: string[] = [];
let fetchAuthHeaders: string[] = [];

function stubMintFlow(opts: { groups?: Record<string, string>; mintOk?: boolean } = {}): void {
  const groups = opts.groups ?? { "Workers Scripts Write": "group-id-workers-write", "D1 Read": "group-id-d1-read" };
  const mintOk = opts.mintOk ?? true;
  fetchCalls = [];
  fetchAuthHeaders = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    fetchCalls.push(`${method} ${url}`);
    fetchAuthHeaders.push(new Headers(init?.headers).get("Authorization") || "");
    if (url.endsWith("/tokens/permission_groups")) {
      return new Response(
        JSON.stringify({ success: true, result: Object.entries(groups).map(([name, id]) => ({ id, name })) }),
        { status: 200 },
      );
    }
    if (method === "POST" && url.endsWith("/tokens")) {
      if (!mintOk) return new Response(JSON.stringify({ success: false }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { value: MINTED_TOKEN } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }) as typeof fetch;
}

async function sealedSession(overrides: Partial<SessionPayload> = {}): Promise<string> {
  const full: SessionPayload = {
    token: POWERFUL_TOKEN,
    scope: [],
    accounts: [
      { id: ACCOUNT_A, name: "A" },
      { id: ACCOUNT_B, name: "B" },
    ],
    accountId: ACCOUNT_A,
    pkg: "a".repeat(64),
    expiresAt: Math.floor(Date.now() / 1000) + 3599,
    mode: "auto",
    ...overrides,
  };
  return `__Host-ov_session=${await encryptSession(full, ENV.OAUTH_COOKIE_KEY)}`;
}

async function call(body: unknown, cookie?: string): Promise<Response> {
  return app.request(
    `${SELF_ORIGIN}/cf/mint-app-token`,
    {
      method: "POST",
      headers: cookie ? { ...RELAY_HEADERS, Cookie: cookie } : RELAY_HEADERS,
      body: JSON.stringify(body),
    },
    ENV,
  );
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  const request = { accountId: ACCOUNT_A, groups: ["Workers Scripts Write", "D1 Read"] };

  // --- route precedence: this literal path must win over the /cf/* wildcard ---
  stubMintFlow();
  const noCookie = await call(request);
  checks.push(["with no session at all, mint is rejected with 403, not the wildcard's allowlist 403", noCookie.status === 403]);
  const noCookieBody = (await noCookie.json()) as { error?: string };
  checks.push(["the 403 comes from mintToken.ts's own session check", noCookieBody.error === "Not signed in"]);

  // --- csrfGate covers /cf/mint-app-token too ---
  stubMintFlow();
  const noRelayHeader = await app.request(
    `${SELF_ORIGIN}/cf/mint-app-token`,
    { method: "POST", headers: { Origin: SELF_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(request) },
    ENV,
  );
  checks.push(["missing Overture-Relay is rejected with 403 before the handler runs", noRelayHeader.status === 403]);
  checks.push(["a csrf rejection never calls Cloudflare", fetchCalls.length === 0]);

  // --- only mode: auto may mint ---
  for (const mode of ["oauth", "manual"] as const) {
    stubMintFlow();
    const wrongMode = await call(request, await sealedSession({ mode }));
    checks.push([`a ${mode}-mode session cannot mint (403)`, wrongMode.status === 403]);
    checks.push([`a ${mode}-mode session's rejection never calls Cloudflare`, fetchCalls.length === 0]);
  }

  // --- accountId must equal session.accountId ---
  stubMintFlow();
  const wrongAccount = await call({ accountId: ACCOUNT_B, groups: ["Workers Scripts Write"] }, await sealedSession());
  checks.push(["a body accountId other than the session's selected account is rejected with 403", wrongAccount.status === 403]);
  checks.push(["the account mismatch is rejected before any Cloudflare call", fetchCalls.length === 0]);

  // --- malformed bodies ---
  stubMintFlow();
  const emptyGroups = await call({ accountId: ACCOUNT_A, groups: [] }, await sealedSession());
  checks.push(["an empty groups array is rejected with 400", emptyGroups.status === 400]);

  stubMintFlow();
  const tooManyGroups = await call({ accountId: ACCOUNT_A, groups: Array(25).fill("Workers Scripts Write") }, await sealedSession());
  checks.push(["more than 24 groups is rejected with 400", tooManyGroups.status === 400]);

  // --- unknown permission group name ---
  stubMintFlow({ groups: { "Workers Scripts Write": "group-id-workers-write" } });
  const unknownGroup = await call({ accountId: ACCOUNT_A, groups: ["Nonexistent Group"] }, await sealedSession());
  checks.push(["a group name Cloudflare does not recognise is rejected with 400", unknownGroup.status === 400]);

  // --- mint failure upstream: fixed text, never echoed ---
  stubMintFlow({ mintOk: false });
  const mintFails = await call(request, await sealedSession());
  const mintFailsBody = (await mintFails.json()) as { ok: boolean; error?: string };
  checks.push(["an upstream mint failure is reported as 502", mintFails.status === 502]);
  checks.push(["the mint failure uses a fixed message, not upstream text", mintFailsBody.error === "Could not mint an application token on this account. Nothing was changed."]);

  // --- the happy path: the powerful token never appears anywhere in the response ---
  stubMintFlow();
  const minted = await call(request, await sealedSession());
  const mintedText = await minted.text();
  checks.push(["a successful mint returns 200", minted.status === 200]);
  checks.push(["the powerful session token never appears in the response body", !mintedText.includes(POWERFUL_TOKEN)]);
  const mintedBody = JSON.parse(mintedText) as { ok: boolean; token?: string };
  checks.push(["the response carries exactly the minted narrow token", mintedBody.ok === true && mintedBody.token === MINTED_TOKEN]);
  checks.push([
    "both upstream calls (permission_groups, mint) authorize with the session's powerful token",
    fetchAuthHeaders.length === 2 && fetchAuthHeaders.every((h) => h === `Bearer ${POWERFUL_TOKEN}`),
  ]);
  checks.push(["the session cookie is left untouched — the deploy still needs it to write the app's Secret", !minted.headers.get("Set-Cookie")]);

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
