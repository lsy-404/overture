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
import type { Capability, Recipe, ResourceKind } from "../recipe/types";

/** Bridge method → the endpoint ids one call of it can reach. */
export const METHOD_ENDPOINTS: Record<string, string[]> = {
  // Provisioning only ever creates: whether there was something to adopt was
  // settled on the options page, out of the inventory the host read there.
  "d1.provision": ["d1.databaseCreate"],
  "d1.query": ["d1.query"],
  "r2.provision": ["r2.bucketCreate"],
  "kv.provision": ["kv.namespaceCreate"],
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
 * Endpoints the wizard itself calls, whatever the package declares: naming the
 * account, and reading the live script before replacing it.
 */
export const HOST_ENDPOINTS: readonly string[] = [
  "account.read",
  "worker.scriptList",
  "worker.scriptRead",
  "worker.settingsRead",
  "worker.deploymentList",
];

/** Reading what the account already holds, so a resource can be matched to it. */
const KIND_INVENTORY: Record<ResourceKind, string> = {
  d1: "d1.databaseList",
  r2: "r2.bucketList",
  kv: "kv.namespaceList",
};

/**
 * The host's own endpoints for one recipe. Listing a kind is unconditional once
 * the recipe declares a resource of it — the options page has to know what is
 * already there before it can say what this deployment will write into — so the
 * read it needs belongs to the wizard's baseline rather than to a capability the
 * package may or may not ask for.
 */
export function hostEndpointsFor(recipe: Recipe): string[] {
  const out = [...HOST_ENDPOINTS];
  for (const resource of recipe.resources) {
    const id = KIND_INVENTORY[resource.kind];
    if (id && !out.includes(id)) out.push(id);
  }
  if ((recipe.worker.containers || []).some((container) => container.image)) {
    out.push("worker.versionRead", "containers.applicationList", "containers.applicationCreate", "containers.applicationModify", "containers.rolloutCreate");
  }
  return out;
}

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
