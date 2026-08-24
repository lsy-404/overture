// SPDX-License-Identifier: AGPL-3.0-or-later

import { hasPaidSubscription, verifyAccount, type CredentialCheck } from "../../src/lib/cf/verify";
import type { Recipe } from "../../src/lib/recipe/types";
import type { DeployCredentials } from "../../src/lib/deploy/types";
import { PACKAGE_ARTIFACT_NAME } from "../../shared/package";

const ACCOUNT_ID = "a".repeat(32);
const credentials: DeployCredentials = { accountId: ACCOUNT_ID, r2AccessKeyId: "", r2SecretAccessKey: "", cfApiToken: "" };
const originalFetch = globalThis.fetch;

function paidRecipe(requirement: "required" | "optional" = "required"): Recipe {
  return {
    schema: 2,
    id: "paid-demo",
    name: "Paid demo",
    summary: { "*": "A demo that needs a paid account." },
    version: "1.0.0",
    tag: "v1.0.0",
    buildTime: "2026-08-24T00:00:00Z",
    package: { artifact: PACKAGE_ARTIFACT_NAME, sha256: "a".repeat(64) },
    license: { id: "AGPL-3.0-or-later", text: "Licence text." },
    authModes: ["auto"],
    permissions: [],
    checks: [
      { id: "paid", requirement, label: { "*": "Paid account" }, path: "/accounts/${accountId}/subscriptions", expect: "paid" },
    ],
    resources: [],
    worker: { defaultName: "paid-demo", module: "worker/index.js" },
    capabilities: [],
    steps: [{ id: "upload", label: { "*": "Upload" } }],
  };
}

async function verifySubscriptions(subscriptions: unknown, requirement: "required" | "optional" = "required") {
  const paths: string[] = [];
  const statuses: CredentialCheck[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    paths.push(String(input));
    return new Response(JSON.stringify({ success: true, result: subscriptions }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const outcome = await verifyAccount(credentials, paidRecipe(requirement), (status) => statuses.push(status));
  return { outcome, paths, statuses };
}

let failures = 0;
const checks: Array<[string, boolean, string?]> = [];

try {
  const paid = await verifySubscriptions([{ state: "Paid" }]);
  const noPaid = await verifySubscriptions([{ state: "Trial" }, { state: "Expired" }]);
  const optionalNoPaid = await verifySubscriptions([], "optional");

  checks.push(
    ["only Cloudflare's exact Paid state counts", hasPaidSubscription([{ state: "Paid" }]) && !hasPaidSubscription([{ state: "paid" }]) && !hasPaidSubscription([{ state: "Trial" }])],
    ["a paid subscription passes the required preflight", paid.outcome.ok && paid.statuses.at(-1)?.status === "ok"],
    ["a non-paid subscription blocks a required deployment", !noPaid.outcome.ok && noPaid.statuses.at(-1)?.status === "missing"],
    ["a non-paid subscription only warns when the check is optional", optionalNoPaid.outcome.ok && optionalNoPaid.statuses.at(-1)?.status === "missing"],
    ["the paid preflight reaches only the account subscriptions path", paid.paths.length === 1 && paid.paths[0] === `/cf/accounts/${ACCOUNT_ID}/subscriptions`],
  );
} finally {
  globalThis.fetch = originalFetch;
}

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
