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

// What an API token has to carry for each relay endpoint, taken from
// Cloudflare's own API schema rather than from a recipe's say-so.
//
// These are OAuth scopes, in Cloudflare's dotted namespace — the strings that
// go into an authorize request and that the consent screen renders. They are a
// different namespace from the Title Case permission groups a classic API token
// carries, and the two do not map one to one.
//
// Unlike a classic token, an OAuth credential cannot be asked what it holds:
// the introspection endpoint answers 401. So nothing here is verified against
// the live credential — this table says what a deployment will need, which is
// what the consent screen has to have granted.
//
// Where Cloudflare's schema does not settle a question, the entry says so rather
// than picking an answer: this table is shown to a user as fact.

const SESSION_JWT = "jwt";

export interface EndpointPermission {
  /** OAuth scopes that authorise the call. All of them are needed, not any one. */
  scopes: string[];
  /**
   * No scope to ask for: the call is authorised by a short-lived token
   * Cloudflare issued for it rather than by the session credential.
   */
  ungated?: typeof SESSION_JWT;
  /** Where Cloudflare's own documentation left the answer incomplete. */
  uncertain?: string;
}

export const ENDPOINT_PERMISSIONS: Record<string, EndpointPermission> = {
  "account.read": { scopes: ["account-settings.read"] },
  "r2.bucketList": { scopes: ["workers-r2.read"] },
  "r2.bucketCreate": { scopes: ["workers-r2.write"] },
  "d1.databaseList": { scopes: ["d1.read"] },
  "d1.databaseCreate": { scopes: ["d1.write"] },
  "d1.query": { scopes: ["d1.write"], uncertain: "writeAssumed" },
  "kv.namespaceList": { scopes: ["workers-kv-storage.read"] },
  "kv.namespaceCreate": { scopes: ["workers-kv-storage.write"] },
  "worker.scriptList": { scopes: ["workers-scripts.read"] },
  "worker.scriptRead": { scopes: ["workers-scripts.read"] },
  "worker.scriptDelete": { scopes: ["workers-scripts.write"] },
  "worker.settingsRead": { scopes: ["workers-scripts.read"] },
  "worker.deploymentList": { scopes: ["workers-scripts.read"] },
  "worker.versionCreate": { scopes: ["workers-scripts.write", "workers-scripts.bind"] },
  "worker.deploymentCreate": { scopes: ["workers-scripts.write"] },
  "worker.assetSession": { scopes: ["workers-scripts.write"] },
  "worker.secretPut": { scopes: ["workers-scripts.write"] },
  "worker.scheduleRead": { scopes: ["workers-scripts.read"] },
  "worker.scheduleWrite": { scopes: ["workers-scripts.write"] },
  "worker.assetUpload": { scopes: [], ungated: SESSION_JWT },
  "worker.domainList": { scopes: ["workers-routes.read"] },
  "worker.domainAttach": { scopes: ["workers-routes.write"], uncertain: "zoneMayBeNeeded" },
  "images.stats": { scopes: ["images.read"] },
  "zone.list": { scopes: ["zone.read"] },
  "zone.imageResizing": { scopes: ["zone-settings.read"] },
};

export interface PermissionNeed {
  /** OAuth scopes, all required together. */
  scopes: string[];
  /** Endpoint ids that need them. */
  endpoints: string[];
  uncertain?: string;
}

/** The distinct scope requirements a set of endpoints adds up to. */
export function permissionsForEndpoints(endpointIds: readonly string[]): PermissionNeed[] {
  const rows = new Map<string, PermissionNeed>();
  for (const id of endpointIds) {
    const permission = ENDPOINT_PERMISSIONS[id];
    if (!permission || permission.scopes.length === 0) continue;
    const key = permission.scopes.join("|");
    const existing = rows.get(key);
    if (existing) {
      existing.endpoints.push(id);
      continue;
    }
    rows.set(key, {
      scopes: [...permission.scopes],
      endpoints: [id],
      ...(permission.uncertain === undefined ? {} : { uncertain: permission.uncertain }),
    });
  }
  return [...rows.values()];
}

/** Every scope a set of endpoints needs, which is what an authorize request asks for. */
export function scopesForEndpoints(endpointIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of endpointIds) {
    for (const scope of ENDPOINT_PERMISSIONS[id]?.scopes || []) out.add(scope);
  }
  return [...out].sort();
}

export interface ScopeDeviation {
  /** Derived needs the self-report never asked for — Cloudflare will refuse this call mid-deployment. */
  underReported: string[];
  /** Self-reported scopes the derived set never accounts for — visible, not blocking. */
  overReported: string[];
}

/**
 * Compares what a recipe's `permissions[].oauthScopes` actually asked Cloudflare
 * for against what the endpoints its declared capabilities reach would need on
 * their own. The two are not the same computation on purpose — one is what an
 * author typed, the other is read off the code — so a gap between them is worth
 * naming rather than silently trusting the author's list.
 */
export function scopeDeviation(reportedScopes: readonly string[], derivedScopes: readonly string[]): ScopeDeviation {
  const reported = new Set(reportedScopes);
  const derived = new Set(derivedScopes);
  return {
    underReported: derivedScopes.filter((scope) => !reported.has(scope)).sort(),
    overReported: reportedScopes.filter((scope) => !derived.has(scope)).sort(),
  };
}
