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

// The policy page's view of the Worker's /policy route. The Worker holds no
// state to authenticate against — the policy is read straight from its own
// vars — so this client only ever reads.

import { MAX_POLICY_SOURCES, normalizeSourceEntry, type DeployPolicy } from "../../shared/policy";

/**
 * `DeployPolicy` plus the one capability flag the wizard needs before offering
 * the "oauth" auth mode: whether this instance's operator has actually
 * configured an OAuth client. Kept here rather than in shared/policy.ts, whose
 * shape belongs to the schema/Worker track.
 */
export interface OverturePolicy extends DeployPolicy {
  oauthEnabled: boolean;
}

const FAILED_POLICY: OverturePolicy = { allowlistEnabled: true, sources: [], oauthEnabled: false };

// Empty (the default) means same-origin relative calls — the Worker serves both
// this app and the policy route. Only set VITE_RELAY_URL when the frontend is
// deployed separately from the Worker it talks to.
function base(): string {
  return (import.meta.env.VITE_RELAY_URL || "").trim().replace(/\/+$/, "");
}

/**
 * A policy document is an answer from the network, so it is narrowed here before
 * anything else reads it: unknown fields dropped, entries that aren't
 * `owner/repo` dropped, the list capped, an absent allowlist flag treated as
 * "on" so a malformed answer fails closed, and an absent oauthEnabled flag
 * treated as "off" so the wizard never offers a sign-in button the Worker
 * cannot actually complete.
 */
function sanitize(input: unknown): OverturePolicy {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<OverturePolicy>;
  const sources: string[] = [];
  for (const entry of Array.isArray(raw.sources) ? raw.sources : []) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeSourceEntry(entry);
    if (normalized && !sources.includes(normalized)) sources.push(normalized);
    if (sources.length >= MAX_POLICY_SOURCES) break;
  }
  return { allowlistEnabled: raw.allowlistEnabled !== false, sources, oauthEnabled: raw.oauthEnabled === true };
}

// A policy read never blocks the wizard: an unreachable or malformed answer
// leaves the allowlist on with nothing on it, which refuses every source rather
// than accepting every source, and leaves oauth off rather than on.
export async function getPolicy(): Promise<OverturePolicy> {
  try {
    const response = await fetch(`${base()}/policy`, { headers: { Accept: "application/json" } });
    if (!response.ok) return FAILED_POLICY;
    return sanitize(await response.json());
  } catch {
    return FAILED_POLICY;
  }
}
