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

// POST /cf/mint-app-token resolves a recipe's declared permission-group names
// to ids and mints a narrow, long-lived Account API Token scoped to exactly
// those groups on exactly the session's selected account. It sits under
// /cf/* so it inherits that prefix's csrfGate (worker/index.ts), but it is not
// a Cloudflare passthrough like worker/cfProxy.ts: the only thing this ever
// hands back is the minted token's own value, never the powerful session
// token that authorized minting it. Cloudflare itself refuses to let a token
// minted by a token hold token-management permissions (error 1001), so the
// minted value cannot be used to mint or delete anything even if it leaked.
//
// The session's powerful token stays live after this call — the deploy
// orchestrator still has to PUT the minted value into the app's Worker Secret
// through /cf/*, authorized by that same session, before it calls
// POST /auth/token/revoke-self (worker/authToken.ts) to end it.

import type { Context } from "hono";
import { jsonResponse } from "./http";
import { BodyTooLargeError, MAX_BODY_BYTES, readBodyWithLimit } from "./limits";
import { readSession } from "./session";
import { fetchPermissionGroupIds, mintAccountToken } from "./cfTokens";

type RelayContext = Context<{ Bindings: Env }>;

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
// Mirrors src/lib/recipe/schema.ts's own MAX_TOKEN_GROUPS: a recipe cannot
// declare more groups than that, so a request naming more is malformed by
// construction, not merely large.
const MAX_TOKEN_GROUPS = 24;
const MAX_GROUP_NAME_CHARS = 128;

const FAILURE = {
  mintFailed: "Could not mint an application token on this account. Nothing was changed.",
} as const;

interface MintRequest {
  accountId: string;
  groups: string[];
}

function isMintRequest(body: unknown): body is MintRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.accountId !== "string" || !Array.isArray(b.groups)) return false;
  if (b.groups.length === 0 || b.groups.length > MAX_TOKEN_GROUPS) return false;
  return b.groups.every((g) => typeof g === "string" && g.length > 0 && g.length <= MAX_GROUP_NAME_CHARS);
}

export async function handleMintAppToken(c: RelayContext): Promise<Response> {
  if (!(c.req.header("Content-Type") || "").toLowerCase().includes("application/json")) {
    return jsonResponse(c, 400, { ok: false, error: "Expected Content-Type: application/json" });
  }

  const session = await readSession(c);
  if (!session) {
    return jsonResponse(c, 403, { ok: false, error: "Not signed in" });
  }
  if (session.mode !== "auto") {
    return jsonResponse(c, 403, { ok: false, error: "Minting an application token requires the automatic authentication mode" });
  }

  let raw: ArrayBuffer;
  try {
    raw = await readBodyWithLimit(c.req.raw, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return jsonResponse(c, 413, { ok: false, error: "Request body too large" });
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonResponse(c, 400, { ok: false, error: "Invalid JSON body" });
  }

  if (!isMintRequest(parsed)) {
    return jsonResponse(c, 400, { ok: false, error: `Expected { accountId, groups } with 1-${MAX_TOKEN_GROUPS} group names` });
  }
  const { accountId, groups } = parsed;

  // Same rule cfProxy.ts enforces on every accounts/{id} relay call: a
  // package may only ever act on the one account this session selected.
  if (!ACCOUNT_ID_RE.test(accountId) || accountId !== session.accountId) {
    return jsonResponse(c, 403, { ok: false, error: "accountId must match the account selected in this session" });
  }

  const groupIds = await fetchPermissionGroupIds(session.token, accountId);
  if (!groupIds) {
    return jsonResponse(c, 502, { ok: false, error: FAILURE.mintFailed });
  }

  const resolvedIds: string[] = [];
  for (const name of groups) {
    const id = groupIds.get(name);
    if (!id) {
      return jsonResponse(c, 400, { ok: false, error: `Unknown permission group: ${name}` });
    }
    resolvedIds.push(id);
  }

  const minted = await mintAccountToken(session.token, accountId, resolvedIds);
  if (!minted) {
    return jsonResponse(c, 502, { ok: false, error: FAILURE.mintFailed });
  }

  return jsonResponse(c, 200, { ok: true, token: minted });
}
