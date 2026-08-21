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

// Auto mode's one job: get the user to a Cloudflare token-creation form that
// is already filled in correctly, and name plainly what it fills in when that
// includes something a normal app should not need.

import { CF_TOKEN_PERMISSIONS, type CfTokenPermission } from "../../../shared/cfTokenPermissions";
import type { CfTokenPermissionRequest } from "../recipe/types";

// The account-scoped token page, reached through the `?to=/:account` redirect
// so no account id has to be known before the user has signed in anywhere —
// the dashboard resolves `:account` itself (and asks which, if there is more
// than one).
export const CF_ACCOUNT_TOKENS_URL = "https://dash.cloudflare.com/?to=/:account/api-tokens";

/**
 * The token-creation link, pre-filled with exactly the permissions a recipe's
 * `cfApiToken` hostSecret declared — `permissionGroupKeys` is Cloudflare's own
 * token-template URL format, an encoded JSON array of `{key,type}` pairs — so
 * the user only has to name the token and create it. Falls back to the bare
 * account token page when there is nothing to pre-fill.
 */
export function buildTokenLinkUrl(permissions: readonly CfTokenPermissionRequest[]): string {
  if (permissions.length === 0) return CF_ACCOUNT_TOKENS_URL;
  const keys = permissions.map((permission) => ({ key: permission.key, type: permission.type }));
  return `${CF_ACCOUNT_TOKENS_URL}&permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}`;
}

export interface PermissionRow extends CfTokenPermissionRequest {
  name: string;
  danger: boolean;
}

/**
 * Every declared permission, with the display name and danger flag the shared
 * table gives it. Every key here already passed that table's ceiling at
 * recipe-load time, so a lookup miss can't happen for a loaded recipe — the
 * raw key is the fallback rather than throwing.
 */
export function describePermissions(permissions: readonly CfTokenPermissionRequest[]): PermissionRow[] {
  return permissions.map((permission) => {
    const known: CfTokenPermission | undefined = CF_TOKEN_PERMISSIONS[permission.key];
    // The escalation risk in the flagged groups (managing tokens, members,
    // billing, Access) is in *writing* them; read on the same group is only
    // visibility, so only an "edit" request is called out as dangerous.
    return { ...permission, name: known?.name ?? permission.key, danger: known?.danger === true && permission.type === "edit" };
  });
}
