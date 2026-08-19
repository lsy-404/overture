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

// Which relay endpoints a capability reaches.
//
// The mapping is not derivable at runtime — a capability is a name on a bridge
// method, and the endpoints behind it are whatever ../deploy/*.ts calls. So it is
// written out here and held to the allowlist by a test: every id below has to
// exist in shared/cfAllowlist.ts, and every gated capability has to appear.

import { CF_ENDPOINTS, type EndpointRule } from "../../../shared/cfAllowlist";
import { METHOD_GATES } from "../sandbox/protocol";
import type { Capability } from "../recipe/types";

/** Bridge method → the endpoint ids one call of it can reach. */
export const METHOD_ENDPOINTS: Record<string, string[]> = {
  "d1.provision": ["d1.databaseList", "d1.databaseCreate"],
  "d1.query": ["d1.query"],
  "r2.provision": ["r2.bucketList", "r2.bucketCreate"],
  "kv.provision": ["kv.namespaceList", "kv.namespaceCreate"],
  "secrets.put": ["worker.secretPut"],
  "secrets.putHostValue": ["worker.secretPut"],
  "worker.deleteScript": ["worker.scriptDelete"],
  "worker.uploadVersion": ["worker.versionCreate"],
  "worker.switchTraffic": ["worker.deploymentCreate"],
  "assets.upload": ["worker.assetSession", "worker.assetUpload"],
  "cron.read": ["worker.scheduleRead"],
  "cron.set": ["worker.scheduleWrite"],
  // Attaching resolves the zone behind the hostname before binding it.
  "domains.list": ["worker.domainList"],
  "domains.attach": ["zone.list", "worker.domainAttach"],
  // A reachability probe is a plain https GET at the deployed app, carrying no
  // credential and passing through no relay endpoint at all.
  "probe.reachable": [],
};

/**
 * Endpoints the wizard itself calls, whatever the package declares: proving the
 * token, naming the account, and reading the live script before replacing it.
 */
export const HOST_ENDPOINTS: readonly string[] = [
  "token.verify",
  "token.read",
  "account.read",
  "worker.scriptList",
  "worker.scriptRead",
  "worker.settingsRead",
  "worker.deploymentList",
];

const BY_ID = new Map<string, EndpointRule>(CF_ENDPOINTS.map((rule) => [rule.id, rule]));

export function endpointById(id: string): EndpointRule | undefined {
  return BY_ID.get(id);
}

/** The endpoint ids a capability can reach, through any of its methods. */
export function endpointsOfCapability(capability: Capability): string[] {
  const out: string[] = [];
  for (const [method, gate] of Object.entries(METHOD_GATES)) {
    if (gate !== capability) continue;
    for (const id of METHOD_ENDPOINTS[method] || []) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The bridge methods a capability gates, in the order the protocol lists them. */
export function methodsOfCapability(capability: Capability): string[] {
  return Object.entries(METHOD_GATES)
    .filter(([, gate]) => gate === capability)
    .map(([method]) => method);
}

/** What an opaque slot holds, read off the literal segment in front of it. */
const OPAQUE_NAMES: Record<string, string> = {
  accounts: "{accountId}",
  scripts: "{scriptName}",
  database: "{databaseId}",
  tokens: "{tokenId}",
  zones: "{zoneId}",
};

/** `/accounts/{accountId}/d1/database` — the shape, for showing a rule to a user. */
export function endpointPath(rule: EndpointRule): string {
  const segments = rule.segments.map((segment, index) => {
    if (segment !== null) return segment;
    const previous = index > 0 ? rule.segments[index - 1] : null;
    return (previous !== null && OPAQUE_NAMES[previous]) || "{id}";
  });
  return `/${segments.join("/")}`;
}
