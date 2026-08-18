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

// Which permission groups matter is the recipe's business, not this file's: a
// row is satisfied by holding any one of the group names it lists, which is how
// a token created with either the modern or the legacy group name still passes.
// Reading a token's own policies is non-mutating and only makes the table exact.

import type { RecipePermission } from "../recipe/types";
import { callCfJson } from "../relay";

interface TokenDetails {
  policies?: Array<{ effect?: string; permission_groups?: Array<{ name?: string }> }>;
}

export async function readTokenPermissionGroups(token: string, accountId: string, tokenId: string): Promise<Set<string>> {
  const details = await callCfJson<TokenDetails>(
    token,
    `/accounts/${accountId}/tokens/${encodeURIComponent(tokenId)}`,
    undefined,
    "Account API Tokens Read",
  );
  return new Set(
    (details.policies || [])
      .filter((policy) => policy.effect === "allow")
      .flatMap((policy) => policy.permission_groups || [])
      .map((group) => group.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

export function hasPermission(groups: Set<string>, permission: RecipePermission): boolean {
  return permission.groups.some((name) => groups.has(name));
}
