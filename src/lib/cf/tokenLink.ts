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
import { matchEndpoint, pathSegments } from "../../../shared/cfAllowlist";
import type { CfTokenPermissionRequest, RecipeCheck, Requirement } from "../recipe/types";

// The account-scoped token page, reached through the `?to=/:account` redirect
// so no account id has to be known before the user has signed in anywhere —
// the dashboard resolves `:account` itself (and asks which, if there is more
// than one).
export const CF_ACCOUNT_TOKENS_URL = "https://dash.cloudflare.com/?to=/:account/api-tokens";

/**
 * The token-creation link, pre-filled with exactly the permissions a recipe's
 * `cfApiToken` hostSecret declared — `permissionGroupKeys` is Cloudflare's own
 * token-template URL format, an encoded JSON array of `{key,type}` pairs. The
 * optional name is a Dashboard default the user may still change.
 */
export function buildTokenLinkUrl(permissions: readonly Pick<CfTokenPermissionRequest, "key" | "type">[], name?: string): string {
  const params: string[] = [];
  if (permissions.length > 0) {
    const keys = permissions.map((permission) => ({ key: permission.key, type: permission.type }));
    params.push(`permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}`);
  }
  const trimmedName = name?.trim();
  if (trimmedName) params.push(`name=${encodeURIComponent(trimmedName)}`);
  return params.length > 0 ? `${CF_ACCOUNT_TOKENS_URL}&${params.join("&")}` : CF_ACCOUNT_TOKENS_URL;
}

export interface PreflightPermission extends Pick<CfTokenPermissionRequest, "key" | "type"> {
  requirement: Requirement;
  checks: RecipeCheck[];
}

const REQUIREMENT_WEIGHT: Record<Requirement, number> = { optional: 0, recommended: 1, required: 2 };

/** Combines one token permission row per Cloudflare permission group. */
export function mergeDeclaredPermissions(
  permissions: readonly CfTokenPermissionRequest[],
): CfTokenPermissionRequest[] {
  const merged = new Map<string, CfTokenPermissionRequest>();
  for (const permission of permissions) {
    const requirement = permission.requirement ?? "required";
    const existing = merged.get(permission.key);
    if (!existing) {
      merged.set(permission.key, { ...permission, requirement });
      continue;
    }
    const strongerType = existing.type === "edit" || permission.type === "read" ? existing.type : permission.type;
    const winner = strongerType === existing.type ? existing : permission;
    const other = winner === existing ? permission : existing;
    const winnerRequirement = winner.requirement ?? "required";
    const otherRequirement = other.requirement ?? "required";
    const requirementWinner = winner.type === other.type && REQUIREMENT_WEIGHT[otherRequirement] > REQUIREMENT_WEIGHT[winnerRequirement]
      ? other
      : winner;
    merged.set(permission.key, {
      ...requirementWinner,
      type: strongerType,
      requirement: requirementWinner.requirement ?? "required",
    });
  }
  return [...merged.values()];
}

/**
 * The only account-token reads that a pre-check may request. The permission is
 * derived from the allow-listed GET endpoint, never supplied by the recipe, so
 * an untrusted package cannot turn a diagnostic path into an authority grant.
 */
export function preflightPermissionsForChecks(checks: readonly RecipeCheck[]): PreflightPermission[] {
  const permissions = new Map<string, PreflightPermission>();
  for (const check of checks) {
    const endpoint = matchEndpoint("GET", pathSegments(check.path));
    const key = endpoint?.accountTokenReadPermission;
    if (!key) continue;
    const existing = permissions.get(key);
    if (existing) {
      existing.checks.push(check);
      if (REQUIREMENT_WEIGHT[check.requirement] > REQUIREMENT_WEIGHT[existing.requirement]) {
        existing.requirement = check.requirement;
      }
    } else {
      permissions.set(key, { key, type: "read", requirement: check.requirement, checks: [check] });
    }
  }
  return [...permissions.values()];
}

/**
 * A token-template key can occur for an app capability and for a pre-check.
 * Keep one row, favouring edit when the app really needs it, instead of giving
 * Cloudflare contradictory read and edit entries for the same permission.
 */
export function mergeTokenPermissions(
  ...groups: ReadonlyArray<readonly Pick<CfTokenPermissionRequest, "key" | "type">[]>
): Array<Pick<CfTokenPermissionRequest, "key" | "type">> {
  const merged = new Map<string, Pick<CfTokenPermissionRequest, "key" | "type">>();
  for (const group of groups) {
    for (const permission of group) {
      const existing = merged.get(permission.key);
      if (!existing || (existing.type === "read" && permission.type === "edit")) {
        merged.set(permission.key, { key: permission.key, type: permission.type });
      }
    }
  }
  return [...merged.values()];
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
