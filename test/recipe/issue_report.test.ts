// SPDX-License-Identifier: AGPL-3.0-or-later

import { issueReport, issueUrl } from "../../src/lib/recipe/issueReport";

const recipe = {
  id: "demo-package",
  version: "1.2.3",
  issues: { url: "https://github.com/acme/demo/issues/new?template=bug.yml" },
};

const report = issueReport(recipe, "upload");
const url = new URL(issueUrl(recipe, "upload"));
const body = url.searchParams.get("body") || "";
const sensitive = ["secret-token", "account-id", "admin-password", "user-input"];
const checks: Array<[string, boolean]> = [
  ["the report contains package id, version, step, and a failure summary", report.includes("demo-package") && report.includes("1.2.3") && report.includes("upload") && report.includes("Error summary")],
  ["the report contains no deployment secret or configuration value", sensitive.every((value) => !report.includes(value))],
  ["the issue URL preserves tracker parameters and pre-fills title and report", url.searchParams.get("template") === "bug.yml" && url.searchParams.get("title") === "Deployment failure: demo-package 1.2.3" && body === report],
  ["the prefilled body is the same strict allowlist report", sensitive.every((value) => !body.includes(value))],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`PASS ${label}`);
  else { failures++; console.error(`FAIL ${label}`); }
}
if (failures) process.exit(1);
