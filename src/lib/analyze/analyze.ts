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

// What a package will do, worked out before it is allowed to do any of it.
//
// The wizard already refuses at two gates — an undeclared capability at the
// bridge, an unlisted path at the relay. Both of those fire mid-deployment, on a
// user who has already handed over a token. This runs the same two tables
// forwards instead: from what the package declared and what its script is
// written to call, to the Cloudflare endpoints that reach, and to the places the
// declaration and the script disagree.
//
// Nothing here calls anything. It reads bytes the wizard already has.

import { matchEndpoint, pathSegments, CF_ENDPOINTS } from "../../../shared/cfAllowlist";
import { METHOD_GATES } from "../sandbox/protocol";
import type { Capability, Recipe, Requirement } from "../recipe/types";
import { endpointPath, endpointsOfCapability, hostEndpointsFor } from "./endpoints";
import { permissionsForEndpoints, scopeDeviation, scopesForEndpoints, type PermissionNeed } from "./permissions";
import { isKnownScope } from "../../../shared/oauthScopes";
import { scanRecipeScript, type NetworkTarget, type ScriptScan } from "./script";

const MAX_FINDINGS = 60;
const MAX_VALUE_CHARS = 120;
/** Stands in for the account id, which is not known when a package is picked. */
const ACCOUNT_PLACEHOLDER = "0".repeat(32);

export type Severity = "critical" | "warning" | "note";

export interface Finding {
  /** Message key under `analyze.findings` in the locale files. */
  code: string;
  severity: Severity;
  values?: Record<string, string>;
}

export interface EndpointUse {
  id: string;
  method: string;
  /** The path shape, opaque segments named. */
  path: string;
  /** Capabilities that reach it; `host` is the wizard's own use. */
  via: string[];
}

export interface CapabilityUse {
  capability: Capability;
  /** Named in recipe.json's `capabilities`. */
  declared: boolean;
  /** A call to one of its methods was found in recipe.js. */
  used: boolean;
  /** Bridge methods found in the script, whether or not declared. */
  methods: string[];
  endpoints: string[];
}

export interface CheckUse {
  id: string;
  requirement: Requirement;
  path: string;
  /** The allow-listed endpoint this path resolves to, or null when none does. */
  endpoint: string | null;
  /** The wizard refuses to send it at all, before the relay gets a say. */
  malformed: boolean;
}

export interface PackageAnalysis {
  capabilities: CapabilityUse[];
  /** Every relay endpoint this deployment can reach, in allowlist order. */
  endpoints: EndpointUse[];
  /** What those endpoints add up to on an API token. */
  permissions: PermissionNeed[];
  checks: CheckUse[];
  /** Hosts recipe.js contacts on its own, outside the bridge. */
  network: NetworkTarget[];
  script: ScriptScan;
  findings: Finding[];
  /** Worst severity among the findings, or null when there are none. */
  worst: Severity | null;
  /**
   * The script read is complete. False means the lists above are a lower bound —
   * the report must say so rather than reading as an all-clear.
   */
  certain: boolean;
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS)}…` : flat;
}

const RANK: Record<Severity, number> = { critical: 3, warning: 2, note: 1 };

/**
 * A check path as `cf/verify.ts` will actually send it: only `${accountId}` is
 * substituted there, so any other token stays in the path and reaches Cloudflare
 * verbatim.
 */
function resolveCheckPath(template: string): { path: string; leftoverToken: string | null; malformed: boolean } {
  const path = template.replace(/\$\{accountId\}/g, ACCOUNT_PLACEHOLDER);
  const leftover = /\$\{([^}]{0,64})\}/.exec(path);
  // The same three refusals cf/verify.ts makes before the request is built.
  const malformed = !path.startsWith("/") || path.includes("..") || path.includes("//");
  return { path, leftoverToken: leftover ? leftover[1] : null, malformed };
}

export function analyzePackage(recipe: Recipe, script: string): PackageAnalysis {
  const scan = scanRecipeScript(script);
  const findings: Finding[] = [];
  const add = (code: string, severity: Severity, values?: Record<string, string>): void => {
    if (findings.length >= MAX_FINDINGS) return;
    findings.push(values ? { code, severity, values } : { code, severity });
  };

  if (!scan.parsed) {
    add("scriptUnparsed", "critical", { detail: clip(scan.parseError || "") });
  }

  // ---- capabilities: declared against called ------------------------------

  const declared = new Set<Capability>(recipe.capabilities || []);
  const gated = new Set<Capability>(
    Object.values(METHOD_GATES).filter((gate): gate is Capability => gate !== null),
  );
  const usedMethods = new Map<Capability, string[]>();
  for (const method of scan.methods) {
    const gate = METHOD_GATES[method];
    if (!gate) continue;
    usedMethods.set(gate, [...(usedMethods.get(gate) || []), method]);
  }

  const capabilities: CapabilityUse[] = [];
  for (const capability of gated) {
    const methods = usedMethods.get(capability) || [];
    const isDeclared = declared.has(capability);
    if (!isDeclared && methods.length === 0) continue;
    capabilities.push({
      capability,
      declared: isDeclared,
      used: methods.length > 0,
      methods,
      endpoints: endpointsOfCapability(capability),
    });
    if (!isDeclared) {
      // The bridge will refuse every one of these at run time, so the package is
      // broken rather than dangerous — but it breaks halfway through a deploy.
      add("undeclaredCapability", "critical", { capability, methods: clip(methods.join(", ")) });
    } else if (methods.length === 0 && scan.parsed && scan.certain) {
      add("unusedCapability", "warning", { capability });
    } else if (methods.length === 0 && scan.parsed) {
      add("unusedCapabilityUncertain", "note", { capability });
    }
  }

  // ---- endpoints ----------------------------------------------------------

  const via = new Map<string, string[]>();
  const note = (id: string, source: string): void => {
    const list = via.get(id);
    if (!list) via.set(id, [source]);
    else if (!list.includes(source)) list.push(source);
  };
  for (const id of hostEndpointsFor(recipe)) note(id, "host");
  for (const entry of capabilities) {
    if (!entry.declared) continue;
    for (const id of entry.endpoints) note(id, entry.capability);
  }

  const endpoints: EndpointUse[] = [];
  for (const rule of CF_ENDPOINTS) {
    const sources = via.get(rule.id);
    if (!sources) continue;
    endpoints.push({ id: rule.id, method: rule.method, path: endpointPath(rule), via: sources });
  }

  // ---- self-reported OAuth scopes against what the code actually reaches ---
  //
  // `recipe.permissions[].oauthScopes` is the author's own word for what this
  // package needs; the authorize request asks for exactly that (unioned with
  // Overture's own baseline). Comparing it against the scopes its *declared
  // capabilities* would need on their own — read off the code, not asked of the
  // author — catches the two ways that word can be wrong: too little, which
  // Cloudflare will refuse mid-deployment, and too much, which is simply worth
  // being able to see.
  const reportedScopes = [...new Set((recipe.permissions || []).flatMap((permission) => permission.oauthScopes))];
  const derivedScopeEndpoints = endpoints.filter((entry) => entry.via.some((source) => source !== "host")).map((entry) => entry.id);
  const derivedScopes = scopesForEndpoints(derivedScopeEndpoints);
  const { underReported, overReported } = scopeDeviation(reportedScopes, derivedScopes);
  if (underReported.length > 0) add("oauthScopeUnderReported", "warning", { scopes: clip(underReported.join(" ")) });
  if (overReported.length > 0) add("oauthScopeOverReported", "warning", { scopes: clip(overReported.join(" ")) });

  // When the package offers OAuth sign-in, every scope its authorize request
  // would carry has to sit within the scopes this Overture's OAuth client was
  // registered to hold. Any that do not would make Cloudflare refuse the whole
  // request, so the wizard drops OAuth for this deployment; recording them here
  // is what tells the user why it was not offered.
  if ((recipe.authModes ?? []).includes("oauth")) {
    const wouldRequest = [...new Set([...reportedScopes, ...scopesForEndpoints(hostEndpointsFor(recipe))])];
    const beyondCeiling = wouldRequest.filter((scope) => !isKnownScope(scope)).sort();
    if (beyondCeiling.length > 0) add("oauthScopeBeyondCeiling", "warning", { scopes: clip(beyondCeiling.join(" ")) });
  }

  // ---- account pre-flight checks ------------------------------------------

  const checks: CheckUse[] = [];
  for (const check of recipe.checks || []) {
    const resolved = resolveCheckPath(check.path);
    // Checks are always sent as GET, so a path that only matches a write rule is
    // no more reachable than one nobody listed.
    const matched = resolved.malformed ? null : matchEndpoint("GET", pathSegments(resolved.path));
    checks.push({
      id: check.id,
      requirement: check.requirement,
      path: clip(check.path),
      endpoint: matched ? matched.id : null,
      malformed: resolved.malformed,
    });

    const severity: Severity = check.requirement === "required" ? "critical" : "warning";
    if (resolved.malformed) {
      add("malformedCheckPath", severity, { check: check.id, path: clip(check.path) });
    } else if (!matched) {
      // This is the one place a package names a Cloudflare address of its own
      // choosing. The relay refuses anything it does not recognise, so an
      // unlisted path is a check that cannot pass — worth saying now rather than
      // on the credentials page with a token already pasted.
      add("unknownCheckEndpoint", severity, { check: check.id, path: clip(check.path) });
    } else if (resolved.leftoverToken) {
      add("checkTokenUnresolved", "warning", { check: check.id, token: clip(resolved.leftoverToken) });
    }
  }

  // ---- what the script reaches on its own ---------------------------------

  if (scan.network.length > 0) {
    add("ownNetwork", "warning", {
      count: String(scan.network.length),
      hosts: clip(scan.network.map((target) => target.origin).join(", ")),
    });
  }
  if (scan.opaqueNetwork > 0) add("opaqueNetwork", "warning", { count: String(scan.opaqueNetwork) });
  // The sandbox refuses this outright, so it is a package that cannot work —
  // and a package that was written expecting to run code it did not ship.
  if (scan.dynamicCode) add("dynamicCode", "critical");
  if (scan.computedAccess) add("computedAccess", "note");

  // ---- credentials the deployed app ends up holding ------------------------

  for (const secret of recipe.hostSecrets || []) {
    if (secret.source === "accountId") add("hostSecretAccountId", "note", { name: secret.name });
    else add("hostSecretCredential", "critical", { name: secret.name, source: secret.source });
  }

  // ---- resources this deployment may write into rather than create ---------

  const adopting = recipe.resources.filter((resource) => resource.match);
  if (adopting.length > 0) {
    // Not a fault — it is how an upgrade keeps its data — but it is the package
    // saying it expects to find something of its own already in the account, and
    // the user is the one who knows whether that is true.
    add("adoptsExisting", "note", {
      resources: clip(adopting.map((resource) => resource.id).join(", ")),
    });
  }

  // ---- a generated password landing in a readable place --------------------

  const passwordInputs = new Set((recipe.inputs || []).filter((input) => input.kind === "password").map((input) => input.id));
  for (const entry of recipe.worker.vars || []) {
    const referenced = [...entry.value.matchAll(/\$\{input:([^}]{1,64})\}/g)].map((match) => match[1]);
    for (const id of referenced) {
      // Worker vars are plain text in the dashboard; a secret belongs in secrets.
      if (passwordInputs.has(id)) add("passwordInVar", "warning", { var: entry.name, input: id });
    }
  }

  findings.sort((left, right) => RANK[right.severity] - RANK[left.severity]);
  const worst = findings.length > 0 ? findings[0].severity : null;

  return {
    capabilities,
    endpoints,
    permissions: permissionsForEndpoints(endpoints.map((entry) => entry.id)),
    checks,
    network: scan.network,
    script: scan,
    findings,
    worst,
    certain: scan.parsed && scan.certain,
  };
}
