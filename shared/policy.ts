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

// The operator's deploy policy: which repositories this deployment of Overture
// is willing to fetch a package from. Shared by the policy page and the Worker
// that enforces it. Keep this file free of Worker and DOM globals.
//
// The policy lives in the Worker's own plain vars, so there is nothing to store
// and nothing to authenticate: the operator edits wrangler.toml (or the vars in
// the dashboard) and redeploys. That keeps this Worker stateless — it holds no
// record of anything, which is the whole point of a public deployer that other
// people's Cloudflare tokens pass through.
//
// A package is third-party code that runs against the visitor's own Cloudflare
// account, so the allowlist starts enabled: an unset ALLOWLIST_ENABLED means on.
// Turning it off makes this a deployer for any repository on GitHub — an operator
// can want that, but it has to be a deliberate `"false"`.

import { parseSource, sourceSlug, type SourceRef } from "./package";

export const MAX_POLICY_SOURCES = 200;

export interface DeployPolicy {
  allowlistEnabled: boolean;
  /** `owner/repo`, lowercased, de-duplicated. */
  sources: string[];
}

/** Returns the canonical `owner/repo`, or null when the entry isn't one. */
export function normalizeSourceEntry(value: string): string | null {
  const ref = parseSource(value);
  return ref ? sourceSlug(ref).toLowerCase() : null;
}

export function isSourceAllowed(policy: DeployPolicy, ref: SourceRef): boolean {
  if (!policy.allowlistEnabled) return true;
  return policy.sources.includes(sourceSlug(ref).toLowerCase());
}

/** Comma or whitespace separated `owner/repo` list, as the var carries it. */
export function parseSourceList(value: string): string[] {
  const sources: string[] = [];
  for (const entry of value.split(/[,\s]+/)) {
    const normalized = normalizeSourceEntry(entry);
    if (normalized && !sources.includes(normalized)) sources.push(normalized);
    if (sources.length >= MAX_POLICY_SOURCES) break;
  }
  return sources;
}

/**
 * Reads the policy out of the Worker's vars. Both are plain strings because
 * that is all a var can be: anything other than the exact string `"false"`
 * leaves the allowlist on, so a typo fails closed.
 */
export function policyFromVars(vars: { ALLOWLIST_ENABLED?: string; ALLOWED_SOURCES?: string }): DeployPolicy {
  return {
    allowlistEnabled: (vars.ALLOWLIST_ENABLED || "").trim().toLowerCase() !== "false",
    sources: parseSourceList(vars.ALLOWED_SOURCES || ""),
  };
}
