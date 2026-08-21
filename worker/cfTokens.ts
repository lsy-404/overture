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

// Cloudflare's Account API Tokens surface (`/accounts/{id}/tokens/*`) — a
// different namespace from both the dotted OAuth scopes (shared/oauthScopes.ts)
// and the classic user-token endpoints. Every function here is authenticated
// with whatever token the caller passes in and scoped to one account; none of
// them ever see the __Host-ov_session cookie or a Hono Context. Cloudflare
// itself refuses to let a minted token hold token-management permissions
// (error 1001), so a token this file mints can never call itself.

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export interface CfAccount {
  id: string;
  name: string;
}

interface AccountsEnvelope {
  success?: boolean;
  result?: Array<{ id?: string; name?: string }>;
}

/** The accounts `token` can see, or null if the call fails or the token cannot read them. */
export async function listAccountsForToken(token: string): Promise<CfAccount[] | null> {
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}/accounts`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return null;
  }
  let envelope: AccountsEnvelope;
  try {
    envelope = (await res.json()) as AccountsEnvelope;
  } catch {
    return null;
  }
  if (!res.ok || !envelope.success || !Array.isArray(envelope.result)) return null;
  return envelope.result.filter((a): a is CfAccount => typeof a.id === "string" && typeof a.name === "string");
}

interface VerifyEnvelope {
  success?: boolean;
  result?: { id?: string; status?: string };
}

/** The token's own id, only when it verifies as active on `accountId`. */
export async function verifyAccountToken(token: string, accountId: string): Promise<{ id: string } | null> {
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}/accounts/${accountId}/tokens/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  let envelope: VerifyEnvelope;
  try {
    envelope = (await res.json()) as VerifyEnvelope;
  } catch {
    return null;
  }
  if (!res.ok || !envelope.success || envelope.result?.status !== "active" || typeof envelope.result?.id !== "string") {
    return null;
  }
  return { id: envelope.result.id };
}

interface PermissionGroupsEnvelope {
  success?: boolean;
  result?: Array<{ id?: string; name?: string }>;
}

/** Title-Case permission-group name -> id, resolved against one account. Null on any upstream failure. */
export async function fetchPermissionGroupIds(token: string, accountId: string): Promise<Map<string, string> | null> {
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}/accounts/${accountId}/tokens/permission_groups`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  let envelope: PermissionGroupsEnvelope;
  try {
    envelope = (await res.json()) as PermissionGroupsEnvelope;
  } catch {
    return null;
  }
  if (!res.ok || !envelope.success || !Array.isArray(envelope.result)) return null;
  const byName = new Map<string, string>();
  for (const group of envelope.result) {
    if (typeof group.id === "string" && typeof group.name === "string") byName.set(group.name, group.id);
  }
  return byName;
}

interface MintEnvelope {
  success?: boolean;
  result?: { value?: string };
}

/**
 * Mints a token on `accountId` scoped to exactly `groupIds`, full account
 * resource. Returns the minted value — Cloudflare hands it back only this
 * once — or null on any failure. Never includes a token-management group:
 * Cloudflare itself would refuse that (error 1001) on a token minted by a
 * token rather than a user.
 */
export async function mintAccountToken(powerfulToken: string, accountId: string, groupIds: string[]): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}/accounts/${accountId}/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${powerfulToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `overture-app-${crypto.randomUUID()}`,
        policies: [
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            permission_groups: groupIds.map((id) => ({ id })),
          },
        ],
      }),
    });
  } catch {
    return null;
  }
  let envelope: MintEnvelope;
  try {
    envelope = (await res.json()) as MintEnvelope;
  } catch {
    return null;
  }
  if (!res.ok || !envelope.success || typeof envelope.result?.value !== "string") return null;
  return envelope.result.value;
}

interface DeleteEnvelope {
  success?: boolean;
}

/** Deletes `token` using itself as bearer. True only on a confirmed upstream success. */
export async function selfDeleteAccountToken(token: string, accountId: string): Promise<boolean> {
  const verified = await verifyAccountToken(token, accountId);
  if (!verified) return false;
  try {
    const res = await fetch(`${CF_API_BASE}/accounts/${accountId}/tokens/${verified.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const envelope = (await res.json()) as DeleteEnvelope;
    return res.ok && envelope.success === true;
  } catch {
    return false;
  }
}
