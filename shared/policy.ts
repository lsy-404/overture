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
// A package is third-party code that runs against the visitor's own Cloudflare
// account, so the allowlist starts enabled. Turning it off makes this a deployer
// for any repository on GitHub — an operator can want that, but it has to be a
// deliberate choice rather than the default.

import { parseSource, sourceSlug, type SourceRef } from "./package";

export const POLICY_KV_KEY = "deploy-policy";

export const MAX_POLICY_SOURCES = 200;

export interface DeployPolicy {
  allowlistEnabled: boolean;
  /** `owner/repo`, lowercased, de-duplicated. */
  sources: string[];
  /** ISO timestamp of the last policy write, or an empty string for the seed. */
  updatedAt: string;
}

export function emptyPolicy(): DeployPolicy {
  return { allowlistEnabled: true, sources: [], updatedAt: "" };
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

/**
 * Accepts whatever the policy page or the `DEFAULT_SOURCES` var sends and
 * returns something safe to store: unknown fields dropped, entries that aren't
 * `owner/repo` dropped, list capped.
 */
export function sanitizePolicy(input: unknown, updatedAt: string): DeployPolicy {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<DeployPolicy>;
  const entries = Array.isArray(raw.sources) ? raw.sources : [];
  const sources: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeSourceEntry(entry);
    if (normalized && !sources.includes(normalized)) sources.push(normalized);
    if (sources.length >= MAX_POLICY_SOURCES) break;
  }
  return {
    allowlistEnabled: raw.allowlistEnabled !== false,
    sources,
    updatedAt,
  };
}

/** Comma or whitespace separated `owner/repo` list, as the seed var carries it. */
export function parseSourceList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => normalizeSourceEntry(entry))
    .filter((entry): entry is string => !!entry);
}
