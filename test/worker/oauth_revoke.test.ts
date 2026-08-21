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

// worker/oauthHandlers.ts's POST /oauth/revoke, mode-branched: oauth revokes
// upstream through the OAuth client (best-effort), auto self-deletes the
// pasted token with itself as bearer and reports failure rather than
// swallowing it, manual never calls Cloudflare at all since the token is the
// user's own. The local cookie always clears, regardless of mode or outcome.

import app from "../../worker/index";
import { encryptSession, type SessionPayload } from "../../worker/oauth";

const ENV = {
  OAUTH_CLIENT_ID: "test-client-id",
  OAUTH_REDIRECT_URI: "https://relay.example/oauth/callback",
  OAUTH_CLIENT_SECRET: "test-client-secret",
  OAUTH_COOKIE_KEY: "oauth-revoke-test-cookie-key",
} as unknown as Env;

const SELF_ORIGIN = "https://relay.example";
const RELAY_HEADERS = { "Overture-Relay": "1", Origin: SELF_ORIGIN };
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const OWN_TOKEN_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let fetchCalls: string[] = [];

function stubFetch(handler: (url: string, method: string) => Response): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    fetchCalls.push(`${method} ${url}`);
    return handler(url, method);
  }) as typeof fetch;
}

async function sealedSession(overrides: Partial<SessionPayload> = {}): Promise<string> {
  const full: SessionPayload = {
    token: "session-credential",
    scope: [],
    accounts: [{ id: ACCOUNT_ID, name: "Test Account" }],
    accountId: ACCOUNT_ID,
    pkg: "a".repeat(64),
    expiresAt: Math.floor(Date.now() / 1000) + 3599,
    mode: "oauth",
    ...overrides,
  };
  return `__Host-ov_session=${await encryptSession(full, ENV.OAUTH_COOKIE_KEY)}`;
}

async function revoke(cookie?: string): Promise<Response> {
  return app.request(
    `${SELF_ORIGIN}/oauth/revoke`,
    { method: "POST", headers: cookie ? { ...RELAY_HEADERS, Cookie: cookie } : RELAY_HEADERS },
    ENV,
  );
}

function isCleared(res: Response): boolean {
  return (res.headers.get("Set-Cookie") || "").includes("Max-Age=0");
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  // --- no session at all: still a clean, cleared 200 ---
  stubFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const noSession = await revoke();
  const noSessionBody = (await noSession.json()) as { ok: boolean };
  checks.push(["revoking with no session reports ok: true", noSession.status === 200 && noSessionBody.ok === true]);
  checks.push(["revoking with no session still clears the cookie", isCleared(noSession)]);
  checks.push(["revoking with no session never calls Cloudflare", fetchCalls.length === 0]);

  // --- oauth mode: calls Cloudflare's OAuth revoke endpoint, best-effort ---
  stubFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const oauthMode = await revoke(await sealedSession({ mode: "oauth" }));
  const oauthBody = (await oauthMode.json()) as { ok: boolean };
  checks.push(["oauth-mode revoke reports ok: true on upstream success", oauthMode.status === 200 && oauthBody.ok === true]);
  checks.push(["oauth-mode revoke calls Cloudflare's oauth2/revoke endpoint", fetchCalls.some((c) => c.includes("oauth2/revoke"))]);
  checks.push(["oauth-mode revoke clears the cookie", isCleared(oauthMode)]);

  stubFetch(() => {
    throw new Error("network down");
  });
  const oauthUpstreamDown = await revoke(await sealedSession({ mode: "oauth" }));
  const oauthDownBody = (await oauthUpstreamDown.json()) as { ok: boolean };
  checks.push(["oauth-mode revoke is best-effort: an upstream failure still reports ok: true", oauthUpstreamDown.status === 200 && oauthDownBody.ok === true]);
  checks.push(["oauth-mode revoke still clears the cookie when upstream is unreachable", isCleared(oauthUpstreamDown)]);

  // --- auto mode: self-deletes, and failure is never silent ---
  stubFetch((url, method) => {
    if (url.endsWith("/tokens/verify")) {
      return new Response(JSON.stringify({ success: true, result: { id: OWN_TOKEN_ID, status: "active" } }), { status: 200 });
    }
    if (method === "DELETE") {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  });
  const autoSuccess = await revoke(await sealedSession({ mode: "auto" }));
  const autoSuccessBody = (await autoSuccess.json()) as { ok: boolean };
  checks.push(["auto-mode revoke reports ok: true when self-delete succeeds", autoSuccess.status === 200 && autoSuccessBody.ok === true]);
  checks.push(["auto-mode revoke issues a DELETE against the token's own id", fetchCalls.some((c) => c.startsWith("DELETE") && c.includes(OWN_TOKEN_ID))]);
  checks.push(["auto-mode revoke never calls the OAuth revoke endpoint", !fetchCalls.some((c) => c.includes("oauth2/revoke"))]);
  checks.push(["auto-mode revoke clears the cookie on success", isCleared(autoSuccess)]);

  stubFetch((url) => {
    if (url.endsWith("/tokens/verify")) {
      return new Response(JSON.stringify({ success: true, result: { id: OWN_TOKEN_ID, status: "active" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 500 });
  });
  const autoFail = await revoke(await sealedSession({ mode: "auto" }));
  const autoFailBody = (await autoFail.json()) as { ok: boolean; error?: string };
  checks.push(["auto-mode revoke reports ok: false when self-delete fails — not silent", autoFail.status === 200 && autoFailBody.ok === false]);
  checks.push(["auto-mode revoke's failure carries an actionable message", typeof autoFailBody.error === "string" && autoFailBody.error.length > 0]);
  checks.push(["auto-mode revoke still clears the cookie even when self-delete fails", isCleared(autoFail)]);

  // --- manual mode: the token is the user's own — nothing is called ---
  stubFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const manualMode = await revoke(await sealedSession({ mode: "manual" }));
  const manualBody = (await manualMode.json()) as { ok: boolean };
  checks.push(["manual-mode revoke reports ok: true", manualMode.status === 200 && manualBody.ok === true]);
  checks.push(["manual-mode revoke never calls Cloudflare — the token is the user's own", fetchCalls.length === 0]);
  checks.push(["manual-mode revoke still clears the local cookie", isCleared(manualMode)]);

  // --- csrfGate still covers this route ---
  stubFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const noRelayHeader = await app.request(`${SELF_ORIGIN}/oauth/revoke`, { method: "POST", headers: { Origin: SELF_ORIGIN } }, ENV);
  checks.push(["POST /oauth/revoke without Overture-Relay is rejected with 403", noRelayHeader.status === 403]);

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
