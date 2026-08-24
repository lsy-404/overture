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

// The relay's second gate. It must stay an exact method-plus-shape match: a
// prefix match, or one extra segment slipping through, turns the relay into a
// general-purpose proxy carrying the visitor's Cloudflare token.
//
// The rule table below is written out independently of the implementation, so a
// path quietly added to or dropped from the allowlist shows up here.

import { isPathAllowed } from "../../shared/cfAllowlist";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "my-worker";
const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** `null` is an opaque segment: any non-traversal, non-empty value. */
interface Rule {
  method: string;
  segments: Array<string | null>;
}

const RULES: Rule[] = [
  { method: "GET", segments: ["accounts", null] },
  { method: "GET", segments: ["accounts", null, "subscriptions"] },
  { method: "GET", segments: ["accounts", null, "r2", "buckets"] },
  { method: "POST", segments: ["accounts", null, "r2", "buckets"] },
  { method: "GET", segments: ["accounts", null, "d1", "database"] },
  { method: "POST", segments: ["accounts", null, "d1", "database"] },
  { method: "POST", segments: ["accounts", null, "d1", "database", null, "query"] },
  { method: "GET", segments: ["accounts", null, "storage", "kv", "namespaces"] },
  { method: "POST", segments: ["accounts", null, "storage", "kv", "namespaces"] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts"] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts", null] },
  { method: "DELETE", segments: ["accounts", null, "workers", "scripts", null] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts", null, "settings"] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts", null, "deployments"] },
  { method: "POST", segments: ["accounts", null, "workers", "scripts", null, "versions"] },
  { method: "POST", segments: ["accounts", null, "workers", "scripts", null, "deployments"] },
  { method: "POST", segments: ["accounts", null, "workers", "scripts", null, "assets-upload-session"] },
  { method: "PUT", segments: ["accounts", null, "workers", "scripts", null, "secrets"] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts", null, "schedules"] },
  { method: "PUT", segments: ["accounts", null, "workers", "scripts", null, "schedules"] },
  { method: "POST", segments: ["accounts", null, "workers", "assets", "upload"] },
  { method: "GET", segments: ["accounts", null, "workers", "domains"] },
  { method: "PUT", segments: ["accounts", null, "workers", "domains"] },
  // Read-only probes a recipe's account preflight can point at.
  { method: "GET", segments: ["accounts", null, "images", "v1", "stats"] },
  { method: "GET", segments: ["zones"] },
  { method: "GET", segments: ["zones", null, "settings", "image_resizing"] },
];

type Call = [string, string[]];

/** Fills a rule's opaque slots with values shaped like the real ones. */
function instantiate(rule: Rule): Call {
  let seen = 0;
  const segments = rule.segments.map((segment) => {
    if (segment !== null) return segment;
    seen++;
    if (seen === 1) return ACCOUNT;
    return rule.segments.includes("scripts") ? SCRIPT : ID;
  });
  return [rule.method, segments];
}

function matchesSomeRule([method, segments]: Call): boolean {
  return RULES.some(
    (rule) =>
      rule.method === method &&
      rule.segments.length === segments.length &&
      rule.segments.every((expected, index) => (expected === null ? !!segments[index] : expected === segments[index])),
  );
}

const describe = ([method, segments]: Call) => `${method} /${segments.join("/")}`;
const allowed = RULES.map(instantiate);

/** One extra segment, one missing segment, and every other method, per rule. */
const variants: Call[] = allowed
  .flatMap(([method, segments]): Call[] => [
    [method, [...segments, "extra"]],
    [method, segments.slice(0, -1)],
    ...["GET", "POST", "PUT", "DELETE", "PATCH"]
      .filter((candidate) => candidate !== method)
      .map((candidate): Call => [candidate, segments]),
  ])
  // A longer or shorter shape can legitimately be another rule; only the
  // variants no rule covers are supposed to be refused.
  .filter((call) => !matchesSomeRule(call));

const traversal: Call[] = [
  ["GET", ["accounts", "..", "tokens", "verify"]],
  ["GET", ["accounts", ".", "tokens", "verify"]],
  ["GET", ["accounts", ACCOUNT, "workers", "scripts", ".."]],
  ["GET", ["accounts", ACCOUNT, "workers", "scripts", "a%2fb"]],
  ["GET", ["accounts", ACCOUNT, "workers", "scripts", "a%2Fb"]],
  ["GET", ["accounts", "", "tokens", "verify"]],
  ["POST", ["accounts", ACCOUNT, "d1", "database", "", "query"]],
];

const unlisted: Call[] = [
  ["GET", ["user", "tokens"]],
  ["GET", ["accounts"]],
  ["POST", ["accounts", ACCOUNT, "tokens"]],
  // Removed with the manual-token flow: an OAuth credential answers 401 here.
  ["GET", ["accounts", ACCOUNT, "tokens", ID]],
  ["GET", ["accounts", ACCOUNT, "tokens", "verify"]],
  ["DELETE", ["accounts", ACCOUNT, "r2", "buckets", "some-bucket"]],
  ["GET", ["zones", ID, "dns_records"]],
  ["POST", ["accounts", ACCOUNT, "workers", "scripts", SCRIPT, "content"]],
  ["GET", ["accounts", ACCOUNT, "storage", "kv", "namespaces", ID, "values", "key"]],
  ["PUT", ["accounts", ACCOUNT, "storage", "kv", "namespaces", ID, "values", "key"]],
  ["GET", []],
];

const refused = allowed.filter((call) => !isPathAllowed(call[0], call[1]));
const leakedVariants = variants.filter((call) => isPathAllowed(call[0], call[1]));
const leakedTraversal = traversal.filter((call) => isPathAllowed(call[0], call[1]));
const leakedUnlisted = unlisted.filter((call) => isPathAllowed(call[0], call[1]));

const checks: Array<[string, boolean, string?]> = [
  ["every path the deploy needs is allowed", refused.length === 0, refused.map(describe).join(", ")],
  ["the KV namespace list and create entries are present",
    isPathAllowed("GET", ["accounts", ACCOUNT, "storage", "kv", "namespaces"])
    && isPathAllowed("POST", ["accounts", ACCOUNT, "storage", "kv", "namespaces"])],
  ["the Workers custom domain entries are present",
    isPathAllowed("GET", ["accounts", ACCOUNT, "workers", "domains"])
    && isPathAllowed("PUT", ["accounts", ACCOUNT, "workers", "domains"])],
  ["matching is exact on segment count and method", leakedVariants.length === 0, leakedVariants.map(describe).join(", ")],
  ["traversal, encoded slashes and empty segments are refused", leakedTraversal.length === 0, leakedTraversal.map(describe).join(", ")],
  ["nothing outside the list is relayed", leakedUnlisted.length === 0, leakedUnlisted.map(describe).join(", ")],
  ["a lowercased method is not accepted for an allowed shape",
    !isPathAllowed("get", ["accounts", ACCOUNT, "r2", "buckets"])],
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
