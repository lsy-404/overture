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
// them ever see the __Host-ov_session cookie or a Hono Context. Used only to
// confirm a pasted token is real before it is sealed into the session
// (worker/authToken.ts) — there is no minting here, since auto mode's token
// is the user's own long-lived object, not something Overture creates.

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
