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

// worker/policy.ts's GET /policy, exercised through the real app: the
// allowlist fields still come straight from shared/policy.ts's
// policyFromVars, and oauthEnabled rides along as a plain boolean of whether
// this deployment's vars carry an OAUTH_CLIENT_ID at all — the wizard needs
// this to know whether oauth is offerable before a recipe's authModes are
// intersected with what the server can actually do.

import app from "../../worker/index";

const SELF_ORIGIN = "https://relay.example";

async function getPolicy(env: Partial<Env>): Promise<Response> {
  return app.request(`${SELF_ORIGIN}/policy`, {}, env as unknown as Env);
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  const withClient = await getPolicy({
    OAUTH_CLIENT_ID: "test-client-id",
    OAUTH_REDIRECT_URI: "https://relay.example/oauth/callback",
  });
  const withClientBody = (await withClient.json()) as Record<string, unknown>;
  checks.push(["GET /policy is public and returns 200", withClient.status === 200]);
  checks.push(["oauthEnabled is true when OAUTH_CLIENT_ID is set", withClientBody.oauthEnabled === true]);
  checks.push(["the allowlist fields are still present alongside oauthEnabled", typeof withClientBody.allowlistEnabled === "boolean" && Array.isArray(withClientBody.sources)]);

  const withoutClient = await getPolicy({});
  const withoutClientBody = (await withoutClient.json()) as Record<string, unknown>;
  checks.push(["oauthEnabled is false when OAUTH_CLIENT_ID is unset", withoutClientBody.oauthEnabled === false]);

  const emptyClient = await getPolicy({ OAUTH_CLIENT_ID: "" });
  const emptyClientBody = (await emptyClient.json()) as Record<string, unknown>;
  checks.push(["oauthEnabled is false when OAUTH_CLIENT_ID is an empty string", emptyClientBody.oauthEnabled === false]);

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
