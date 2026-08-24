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

// The table below is the second of the two gates a Cloudflare call passes (the
// first being the recipe's declared capabilities). CONTRACT.md §2 records what
// each entry is for; keep the two in sync.
//
// Matching is method + exact segment count + exact literal segments. There is
// deliberately no prefix match and no variable-length pattern: a package can
// only reach endpoints someone listed here on purpose.
//
// It lives in shared/ because the relay is not the only reader: the package
// analyser resolves a recipe's declared work against this same table to tell the
// user which endpoints a package will reach, and which of the paths it named are
// not endpoints at all. Two copies of this table would eventually disagree, and
// the disagreement would be a wizard promising one thing and a relay doing
// another. Keep this file free of Worker and DOM globals.

// `null` marks an opaque path segment (accountId / scriptName / dbId / …):
// any non-empty value is accepted, format is not further validated.
export type Segment = string | null;

export interface EndpointRule {
  /** Stable id, so an endpoint can be named outside this table. */
  id: string;
  method: string;
  segments: Segment[];
  /**
   * Account-token permission the wizard must pre-fill to run this GET as an
   * account pre-check. Omitted for writes and for any endpoint that must never
   * become a recipe-driven pre-check permission request.
   */
  accountTokenReadPermission?: string;
  /**
   * This one entry does not carry the session's Cloudflare token: the asset
   * upload session itself hands back a short-lived JWT, and the caller sends
   * that JWT as its own `Authorization` header instead. The relay must never
   * fall back between the two — see worker/cfProxy.ts.
   */
  passthroughAuth?: boolean;
}

export const CF_ENDPOINTS: readonly EndpointRule[] = [
  { id: "account.read", method: "GET", segments: ["accounts", null], accountTokenReadPermission: "account_settings" },
  { id: "account.subscriptionList", method: "GET", segments: ["accounts", null, "subscriptions"], accountTokenReadPermission: "billing" },
  { id: "r2.bucketList", method: "GET", segments: ["accounts", null, "r2", "buckets"], accountTokenReadPermission: "workers_r2" },
  { id: "r2.bucketCreate", method: "POST", segments: ["accounts", null, "r2", "buckets"] },
  { id: "d1.databaseList", method: "GET", segments: ["accounts", null, "d1", "database"], accountTokenReadPermission: "d1" },
  { id: "d1.databaseCreate", method: "POST", segments: ["accounts", null, "d1", "database"] },
  { id: "d1.query", method: "POST", segments: ["accounts", null, "d1", "database", null, "query"] },
  { id: "kv.namespaceList", method: "GET", segments: ["accounts", null, "storage", "kv", "namespaces"], accountTokenReadPermission: "workers_kv_storage" },
  { id: "kv.namespaceCreate", method: "POST", segments: ["accounts", null, "storage", "kv", "namespaces"] },
  { id: "worker.scriptList", method: "GET", segments: ["accounts", null, "workers", "scripts"], accountTokenReadPermission: "workers_scripts" },
  { id: "worker.scriptRead", method: "GET", segments: ["accounts", null, "workers", "scripts", null], accountTokenReadPermission: "workers_scripts" },
  { id: "worker.scriptDelete", method: "DELETE", segments: ["accounts", null, "workers", "scripts", null] },
  { id: "worker.settingsRead", method: "GET", segments: ["accounts", null, "workers", "scripts", null, "settings"], accountTokenReadPermission: "workers_scripts" },
  { id: "worker.deploymentList", method: "GET", segments: ["accounts", null, "workers", "scripts", null, "deployments"], accountTokenReadPermission: "workers_scripts" },
  { id: "worker.versionRead", method: "GET", segments: ["accounts", null, "workers", "scripts", null, "versions", null], accountTokenReadPermission: "workers_scripts" },
  { id: "worker.versionCreate", method: "POST", segments: ["accounts", null, "workers", "scripts", null, "versions"] },
  { id: "worker.deploymentCreate", method: "POST", segments: ["accounts", null, "workers", "scripts", null, "deployments"] },
  {
    id: "worker.assetSession",
    method: "POST",
    segments: ["accounts", null, "workers", "scripts", null, "assets-upload-session"],
  },
  { id: "worker.secretPut", method: "PUT", segments: ["accounts", null, "workers", "scripts", null, "secrets"] },
  { id: "worker.scheduleRead", method: "GET", segments: ["accounts", null, "workers", "scripts", null, "schedules"], accountTokenReadPermission: "workers_scripts" },
  { id: "worker.scheduleWrite", method: "PUT", segments: ["accounts", null, "workers", "scripts", null, "schedules"] },
  {
    id: "worker.assetUpload",
    method: "POST",
    segments: ["accounts", null, "workers", "assets", "upload"],
    passthroughAuth: true,
  },
  { id: "worker.domainList", method: "GET", segments: ["accounts", null, "workers", "domains"], accountTokenReadPermission: "workers_routes" },
  { id: "worker.domainAttach", method: "PUT", segments: ["accounts", null, "workers", "domains"] },
  { id: "containers.applicationList", method: "GET", segments: ["accounts", null, "containers", "applications"], accountTokenReadPermission: "containers" },
  { id: "containers.applicationCreate", method: "POST", segments: ["accounts", null, "containers", "applications"] },
  { id: "containers.applicationModify", method: "PATCH", segments: ["accounts", null, "containers", "applications", null] },
  { id: "containers.rolloutCreate", method: "POST", segments: ["accounts", null, "containers", "applications", null, "rollouts"] },
  { id: "images.stats", method: "GET", segments: ["accounts", null, "images", "v1", "stats"], accountTokenReadPermission: "images" },
  { id: "zone.list", method: "GET", segments: ["zones"], accountTokenReadPermission: "zone" },
  { id: "zone.imageResizing", method: "GET", segments: ["zones", null, "settings", "image_resizing"], accountTokenReadPermission: "zone_settings" },
];

// Rejects empty segments (already implied by the caller's split/filter),
// "." / ".." traversal, and encoded slashes that could smuggle an extra
// path segment past the segment-count check.
function isValidOpaqueSegment(segment: string): boolean {
  if (!segment) return false;
  if (segment === "." || segment === "..") return false;
  if (/%2f/i.test(segment)) return false;
  return true;
}

/** The rule this call matches, or null when nothing in the table covers it. */
export function matchEndpoint(method: string, segments: string[]): EndpointRule | null {
  for (const rule of CF_ENDPOINTS) {
    if (rule.method !== method) continue;
    if (rule.segments.length !== segments.length) continue;
    let matched = true;
    for (let i = 0; i < rule.segments.length; i++) {
      const expected = rule.segments[i];
      const actual = segments[i];
      if (expected === null) {
        if (!isValidOpaqueSegment(actual)) {
          matched = false;
          break;
        }
      } else if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) return rule;
  }
  return null;
}

export function isPathAllowed(method: string, segments: string[]): boolean {
  return matchEndpoint(method, segments) !== null;
}

/**
 * Splits an API path the way the relay does before matching: the query string
 * is dropped, and `%2F` is left encoded so it cannot become a segment boundary.
 */
export function pathSegments(path: string): string[] {
  const query = path.indexOf("?");
  const withoutQuery = query === -1 ? path : path.slice(0, query);
  const hash = withoutQuery.indexOf("#");
  return (hash === -1 ? withoutQuery : withoutQuery.slice(0, hash)).split("/").filter(Boolean);
}
