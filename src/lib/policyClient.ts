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

// Empty (the default) means same-origin relative calls — the Worker serves both
// this app and the policy route. Only set VITE_RELAY_URL when the frontend is
// deployed separately from the Worker it talks to.
function base(): string {
  return (import.meta.env.VITE_RELAY_URL || "").trim().replace(/\/+$/, "");
}

/**
 * A policy document is an answer from the network, so it is narrowed here before
 * anything else reads it: unknown fields dropped, entries that aren't
 * `owner/repo` dropped, the list capped, and an absent flag treated as "on" so a
 * malformed answer fails closed.
 */
function sanitize(input: unknown): DeployPolicy {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<DeployPolicy>;
  const sources: string[] = [];
  for (const entry of Array.isArray(raw.sources) ? raw.sources : []) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeSourceEntry(entry);
    if (normalized && !sources.includes(normalized)) sources.push(normalized);
    if (sources.length >= MAX_POLICY_SOURCES) break;
  }
  return { allowlistEnabled: raw.allowlistEnabled !== false, sources };
}

// A policy read never blocks the wizard: an unreachable or malformed answer
// leaves the allowlist on with nothing on it, which refuses every source rather
// than accepting every source.
export async function getPolicy(): Promise<DeployPolicy> {
  try {
    const response = await fetch(`${base()}/policy`, { headers: { Accept: "application/json" } });
    if (!response.ok) return { allowlistEnabled: true, sources: [] };
    return sanitize(await response.json());
  } catch {
    return { allowlistEnabled: true, sources: [] };
  }
}
