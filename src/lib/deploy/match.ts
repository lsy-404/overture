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

// Deciding which resource a deployment writes into.
//
// The old answer was "the one with the name we would create, if it happens to
// exist" — which quietly deploys an upgrade against an empty database whenever
// the app's naming ever changed, leaving the real one bound to nothing. A recipe
// can now say how to recognise its own: exact names first, in the order given,
// then patterns.
//
// Exact before pattern, and one pattern hit before none, but never a guess: a
// pattern that matches several existing resources adopts none of them. Choosing
// wrong here means writing into someone else's data, and the cost of the two
// mistakes is not symmetrical — so the ambiguity goes to the user instead.

import type { RecipeResource } from "../recipe/types";
import type { DeployTarget, ExistingResource } from "./types";

/**
 * The name a deployment actually uses for each resource. An adopted resource
 * keeps its own name, whatever was in the options-page field — everything that
 * names a resource downstream has to agree on which thing is being written into,
 * or a binding points at one database while the var beside it names another.
 */
export function effectiveResourceNames(target: DeployTarget): Record<string, string> {
  const out = { ...target.resourceNames };
  for (const [id, entry] of Object.entries(target.adopted)) out[id] = entry.name;
  return out;
}

/** Where the adopted resource was named. */
export type MatchVia = "chosen" | "declared" | "pattern";

export interface ResourceMatch {
  outcome: "adopt" | "create" | "ambiguous";
  /** Set when `outcome` is "adopt". */
  adopt?: ExistingResource;
  via?: MatchVia;
  /** The declaration that matched, for the report and the options page. */
  matched?: string;
  /** Set when `outcome` is "ambiguous": everything that one pattern matched. */
  candidates?: ExistingResource[];
}

/**
 * Whole-string, and compiled per call rather than cached: a recipe's patterns
 * are checked against at most a few hundred names once per options page, and a
 * cache keyed on third-party strings is a leak waiting to be written.
 */
function anchored(source: string): RegExp | null {
  try {
    return new RegExp(`^(?:${source})$`);
  } catch {
    return null;
  }
}

export function matchResource(input: {
  resource: RecipeResource;
  /** The name in the options page field, already interpolated and trimmed. */
  chosenName: string;
  existing: readonly ExistingResource[];
  /** Expands `${worker}` and friends in a declared name. */
  interpolate: (template: string) => string;
}): ResourceMatch {
  const { resource, chosenName, existing, interpolate } = input;
  const byName = new Map<string, ExistingResource>();
  // First writer wins, so a duplicate name in the account cannot shuffle which
  // resource an exact match resolves to between two reads.
  for (const entry of existing) if (!byName.has(entry.name)) byName.set(entry.name, entry);

  // 1. What the user has in the field. They may have typed the name of
  //    something that already exists, and that is an answer in itself.
  const chosen = chosenName ? byName.get(chosenName) : undefined;
  if (chosen) return { outcome: "adopt", adopt: chosen, via: "chosen", matched: chosenName };

  // 2. The names the recipe declares, in its own order.
  for (const template of resource.match?.names || []) {
    const name = interpolate(template).trim();
    if (!name) continue;
    const found = byName.get(name);
    if (found) return { outcome: "adopt", adopt: found, via: "declared", matched: name };
  }

  // 3. Patterns, in order. The first pattern that matches anything decides —
  //    either alone, or by handing its candidates over.
  for (const source of resource.match?.patterns || []) {
    const pattern = anchored(source);
    if (!pattern) continue;
    const hits = existing.filter((entry) => pattern.test(entry.name));
    if (hits.length === 1) return { outcome: "adopt", adopt: hits[0], via: "pattern", matched: source };
    if (hits.length > 1) return { outcome: "ambiguous", candidates: hits, via: "pattern", matched: source };
  }

  return { outcome: "create" };
}
