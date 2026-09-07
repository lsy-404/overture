// SPDX-License-Identifier: AGPL-3.0-or-later

import { hostEndpointsFor } from "../../src/lib/analyze/endpoints";
import { scopesForEndpoints, tokenPermissionsForEndpoints } from "../../src/lib/analyze/permissions";
import { enableWorkersDevUrl } from "../../src/lib/deploy/workersDev";
import type { Recipe } from "../../src/lib/recipe/types";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string; body?: string }> = [];
let initiallyEnabled = false;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method || "GET";
  calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
  if (url.endsWith("/workers/subdomain")) {
    return new Response(JSON.stringify({ success: true, result: { subdomain: "account-name" } }), { headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/scripts/waline/subdomain") && method === "GET") {
    return new Response(JSON.stringify({ success: true, result: { enabled: initiallyEnabled } }), { headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/scripts/waline/subdomain") && method === "POST") {
    return new Response(JSON.stringify({ success: true, result: { enabled: true } }), { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: false, errors: [{ message: "unexpected endpoint" }] }), { status: 400, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function main(): Promise<void> {
  const checks: Array<[string, boolean, string?]> = [];
  try {
    const url = await enableWorkersDevUrl(ACCOUNT, "waline", "en");
    checks.push(["a disabled Worker subdomain is enabled and resolves to its account workers.dev URL",
      url === "https://waline.account-name.workers.dev"
      && calls.map((call) => call.method).join(",") === "GET,GET,POST"
      && calls[2]?.body === JSON.stringify({ enabled: true }), JSON.stringify(calls)]);

    calls.length = 0;
    initiallyEnabled = true;
    const alreadyEnabled = await enableWorkersDevUrl(ACCOUNT, "waline", "en");
    checks.push(["an enabled Worker subdomain is resolved without another mutation",
      alreadyEnabled === "https://waline.account-name.workers.dev" && calls.map((call) => call.method).join(",") === "GET,GET", JSON.stringify(calls)]);

    const hostEndpoints = hostEndpointsFor({ resources: [], checks: [], worker: {}, capabilities: ["worker"] } as Recipe);
    const hostScopes = scopesForEndpoints(hostEndpoints);
    checks.push(["workers.dev resolution is in the host authorization baseline for OAuth and API-token deployments",
      hostEndpoints.includes("worker.subdomainRead")
      && hostEndpoints.includes("worker.subdomainEnable")
      && hostEndpoints.includes("worker.accountSubdomainRead")
      && hostScopes.includes("workers-scripts.read")
      && hostScopes.includes("workers-scripts.write"), JSON.stringify({ hostEndpoints, hostScopes })]);

    const tokenPermissions = tokenPermissionsForEndpoints([
      "account.read", "d1.databaseCreate", "worker.versionCreate", "worker.domainAttach", "zone.list",
    ]);
    checks.push(["an Account API Token is derived from the deployment endpoints instead of an app-owned token declaration",
      JSON.stringify(tokenPermissions) === JSON.stringify([
        { key: "account_settings", type: "read" },
        { key: "d1", type: "edit" },
        { key: "workers_scripts", type: "edit" },
        { key: "workers_routes", type: "edit" },
        { key: "zone", type: "read" },
      ]), JSON.stringify(tokenPermissions)]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let failures = 0;
  for (const [label, passed, detail] of checks) {
    if (passed) console.log(`PASS ${label}`);
    else {
      failures++;
      console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }
  if (failures) process.exit(1);
}

void main();
