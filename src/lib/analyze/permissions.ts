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
// Two things about Cloudflare's naming decide the shape of this file:
//
//   - Every endpoint's gate is a disjunction. Holding any one of the names
//     listed for it is enough; none of them requires two groups together.
//   - "Write" and "Edit" are the same permission group shown twice. The
//     dashboard prints "Edit", the API answers "Write", and a token's own
//     policies always read back in the API spelling. So the names below are the
//     API spelling, and `dashboardLabel` derives what the user will actually see
//     on the checkbox they are told to tick.
//
// Where Cloudflare's schema does not settle a question, the entry says so rather
// than picking an answer: this table is shown to a user as fact.

const ANY_DEPLOY_TOKEN = "any";
const SESSION_JWT = "jwt";

export interface EndpointPermission {
  /** API permission-group names. Holding any one authorises the call. */
  groups: string[];
  /**
   * No group to ask for: `any` because every token that can deploy at all
   * already passes, `jwt` because the call carries its own short-lived
   * credential instead of the API token.
   */
  ungated?: typeof ANY_DEPLOY_TOKEN | typeof SESSION_JWT;
  /** Where Cloudflare's schema left the answer incomplete. Shown, not hidden. */
  uncertain?: string;
}

export const ENDPOINT_PERMISSIONS: Record<string, EndpointPermission> = {
  // The verify call has no group recorded against it — which is an absent
  // schema key, not a documented "needs nothing".
  "token.verify": { groups: [], ungated: ANY_DEPLOY_TOKEN, uncertain: "unrecorded" },
  "token.read": {
    groups: ["Account API Tokens Read", "Account API Tokens Write"],
    uncertain: "noDashboardRow",
  },
  // Twenty-nine different groups satisfy this one, so any token that can deploy
  // already does. Asking a user to add a permission for it would be wrong.
  "account.read": { groups: [], ungated: ANY_DEPLOY_TOKEN },

  "r2.bucketList": { groups: ["Workers R2 Storage Read", "Workers R2 Storage Write"] },
  "r2.bucketCreate": { groups: ["Workers R2 Storage Write"] },

  "d1.databaseList": { groups: ["D1 Read", "D1 Write"] },
  "d1.databaseCreate": { groups: ["D1 Write"] },
  // The published gate also admits D1 Read, but nothing states what a read-only
  // token does with the schema statements a recipe runs here.
  "d1.query": { groups: ["D1 Write"], uncertain: "writeAssumed" },

  "kv.namespaceList": { groups: ["Workers KV Storage Read", "Workers KV Storage Write"] },
  "kv.namespaceCreate": { groups: ["Workers KV Storage Write"] },

  "worker.scriptList": { groups: ["Workers Scripts Read", "Workers Scripts Write", "Workers Tail Read"] },
  "worker.scriptRead": { groups: ["Workers Scripts Read", "Workers Scripts Write", "Workers Tail Read"] },
  "worker.scriptDelete": { groups: ["Workers Scripts Write"] },
  "worker.settingsRead": { groups: ["Workers Scripts Read", "Workers Scripts Write", "Workers Tail Read"] },
  "worker.deploymentList": { groups: ["Workers Scripts Read", "Workers Scripts Write", "Workers Tail Read"] },
  "worker.versionCreate": { groups: ["Workers Scripts Write"] },
  "worker.deploymentCreate": { groups: ["Workers Scripts Write"] },
  "worker.assetSession": { groups: ["Workers Scripts Write"] },
  "worker.secretPut": { groups: ["Workers Scripts Write"] },
  "worker.scheduleRead": { groups: ["Workers Scripts Read", "Workers Scripts Write"] },
  "worker.scheduleWrite": { groups: ["Workers Scripts Write"] },
  // Authorised by the upload session's own JWT, never by the account token.
  "worker.assetUpload": { groups: [], ungated: SESSION_JWT },
  "worker.domainList": { groups: ["Workers Scripts Read", "Workers Scripts Write"] },
  // Attaching a domain also provisions DNS and a certificate on the target zone,
  // so this may additionally want zone-level Workers Routes Write. Unproven.
  "worker.domainAttach": { groups: ["Workers Scripts Write"], uncertain: "zoneMayBeNeeded" },

  "images.stats": { groups: ["Images Read", "Images Write"] },
  "zone.list": { groups: ["Zone Read"] },
  "zone.imageResizing": { groups: ["Zone Settings Read", "Zone Settings Write"] },
};

/**
 * What the same permission group is called on the dashboard checkbox: "Write"
 * reads as "Edit" there, and the Images groups gain a "Cloudflare " prefix.
 */
export function dashboardLabel(apiName: string): string {
  const edited = apiName.replace(/ Write$/, " Edit");
  return edited.startsWith("Images ") ? `Cloudflare ${edited}` : edited;
}

export interface PermissionNeed {
  /** Alternatives — any one of these authorises every endpoint listed below. */
  groups: string[];
  /** Endpoint ids that need it. */
  endpoints: string[];
  uncertain?: string;
}

/**
 * The distinct permission requirements a set of endpoints adds up to. Each entry
 * stays a disjunction of its own: two endpoints only share a row when they
 * accept exactly the same alternatives.
 */
export function permissionsForEndpoints(endpointIds: readonly string[]): PermissionNeed[] {
  const rows = new Map<string, PermissionNeed>();
  for (const id of endpointIds) {
    const permission = ENDPOINT_PERMISSIONS[id];
    if (!permission || permission.groups.length === 0) continue;
    const key = permission.groups.join("|");
    const existing = rows.get(key);
    if (existing) {
      existing.endpoints.push(id);
      continue;
    }
    rows.set(key, {
      groups: [...permission.groups],
      endpoints: [id],
      ...(permission.uncertain === undefined ? {} : { uncertain: permission.uncertain }),
    });
  }
  return [...rows.values()];
}
