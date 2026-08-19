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

// The analyser tells a user which Cloudflare endpoints a package can reach and
// what permission that needs. Three tables have to agree for that to be true —
// the bridge's methods, the relay's allowlist, and the permission map — and
// nothing at run time would notice if one of them fell behind. This is what
// notices.

import { CF_ENDPOINTS } from "../../shared/cfAllowlist";
import { METHOD_ENDPOINTS, HOST_ENDPOINTS, endpointPath } from "../../src/lib/analyze/endpoints";
import { ENDPOINT_PERMISSIONS, dashboardLabel } from "../../src/lib/analyze/permissions";
import { METHOD_GATES } from "../../src/lib/sandbox/protocol";

const ids = new Set(CF_ENDPOINTS.map((rule) => rule.id));
const gatedMethods = Object.entries(METHOD_GATES).filter(([, gate]) => gate !== null).map(([method]) => method);

const duplicateIds = CF_ENDPOINTS.map((rule) => rule.id).filter((id, index, all) => all.indexOf(id) !== index);

const methodsWithoutEntry = gatedMethods.filter((method) => METHOD_ENDPOINTS[method] === undefined);

const unknownReferences = [
  ...Object.values(METHOD_ENDPOINTS).flat(),
  ...HOST_ENDPOINTS,
].filter((id) => !ids.has(id));

// A capability that reaches nothing is either a mapping someone forgot or a
// capability that should not exist. `probe` is the one honest empty: it is a
// plain request to the deployed app, carrying no token and passing no relay.
const capabilitiesWithoutEndpoints = [...new Set(Object.values(METHOD_GATES).filter((gate) => gate !== null))].filter(
  (capability) =>
    !gatedMethods.some((method) => METHOD_GATES[method] === capability && (METHOD_ENDPOINTS[method] || []).length > 0),
);

const endpointsWithoutPermission = [...ids].filter((id) => ENDPOINT_PERMISSIONS[id] === undefined);
const permissionsWithoutEndpoint = Object.keys(ENDPOINT_PERMISSIONS).filter((id) => !ids.has(id));

// "Edit" is what the dashboard prints; a token's own policies always read back
// in the "Write" spelling. A gate written against "Edit" could never match.
const editSpellings = Object.entries(ENDPOINT_PERMISSIONS).flatMap(([id, permission]) =>
  permission.groups.filter((group) => group.endsWith(" Edit")).map((group) => `${id}: ${group}`),
);

// An entry with no groups has to say why, or it reads as "needs nothing" when
// what it means is "nobody wrote it down".
const silentlyUngated = Object.entries(ENDPOINT_PERMISSIONS)
  .filter(([, permission]) => permission.groups.length === 0 && !permission.ungated)
  .map(([id]) => id);

const checks: Array<[string, boolean, string?]> = [
  ["endpoint ids are unique", duplicateIds.length === 0, duplicateIds.join(", ")],
  ["every gated bridge method maps to endpoints", methodsWithoutEntry.length === 0, methodsWithoutEntry.join(", ")],
  ["every mapped endpoint id exists in the allowlist", unknownReferences.length === 0, unknownReferences.join(", ")],
  [
    "only probe reaches no Cloudflare endpoint",
    capabilitiesWithoutEndpoints.length === 1 && capabilitiesWithoutEndpoints[0] === "probe",
    capabilitiesWithoutEndpoints.join(", "),
  ],
  ["every allow-listed endpoint has a permission entry", endpointsWithoutPermission.length === 0, endpointsWithoutPermission.join(", ")],
  ["no permission entry names an endpoint that is gone", permissionsWithoutEndpoint.length === 0, permissionsWithoutEndpoint.join(", ")],
  ["permission groups use the API spelling, never the dashboard's", editSpellings.length === 0, editSpellings.join(", ")],
  ["an endpoint needing no permission says why", silentlyUngated.length === 0, silentlyUngated.join(", ")],
  ["the dashboard label is the Edit spelling", dashboardLabel("Workers Scripts Write") === "Workers Scripts Edit"],
  ["the Images groups gain their dashboard prefix", dashboardLabel("Images Read") === "Cloudflare Images Read"],
  ["a read group is not renamed", dashboardLabel("Zone Read") === "Zone Read"],
  [
    "opaque path segments are named after what they hold",
    endpointPath(CF_ENDPOINTS.find((rule) => rule.id === "d1.query")!) === "/accounts/{accountId}/d1/database/{databaseId}/query",
    endpointPath(CF_ENDPOINTS.find((rule) => rule.id === "d1.query")!),
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
