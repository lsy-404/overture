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

// The host builds the Worker's binding set, never the recipe's script: a script
// can ask for a resource its recipe declared and nothing else, so nothing it
// does can bind storage the user was never shown.

import type { DeployMode, Recipe } from "../recipe/types";

export type Binding = Record<string, unknown>;

/**
 * Substitutes the tokens documented in docs/RECIPE.md. `vars` is keyed by the
 * token's own text, so a resource name is `"resource:db"` and an answer is
 * `"input:adminUser"`. An unknown token is left as written rather than emptied,
 * which keeps a typo visible instead of silently producing `""`.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([^{}]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

export interface BuildBindingsInput {
  recipe: Recipe;
  mode: DeployMode;
  /** Resource id → provisioned id (D1 database id, KV namespace id). */
  resourceIds: Record<string, string>;
  /** Resource id → provisioned name (R2 bucket name). */
  resourceNames: Record<string, string>;
  /** Var name → value, already interpolated. */
  vars: Record<string, string>;
  /** Container class names this version declares. */
  declareContainers: string[];
}

export function buildBindings(input: BuildBindingsInput): Binding[] {
  const { recipe, mode, resourceIds, resourceNames, vars, declareContainers } = input;
  const bindings: Binding[] = [];

  // An overwrite inherits storage, secrets and Durable Objects from the live
  // version through `keep_bindings`, so re-declaring them here would only risk
  // pointing a binding at something the user didn't choose this time round. Vars
  // are still written, so a redeploy refreshes version stamps.
  if (mode === "fresh") {
    for (const resource of recipe.resources) {
      const id = resourceIds[resource.id] || "";
      const name = resourceNames[resource.id] || "";
      switch (resource.kind) {
        case "d1":
          if (id) bindings.push({ type: "d1", name: resource.binding, database_id: id });
          break;
        case "r2":
          if (name) bindings.push({ type: "r2_bucket", name: resource.binding, bucket_name: name });
          break;
        case "kv":
          if (id) bindings.push({ type: "kv_namespace", name: resource.binding, namespace_id: id });
          break;
      }
    }
    // A container class is reachable only through a Durable Object binding, and a
    // fresh script has none to inherit. The class name doubles as the binding
    // name — recipe.json names no other candidate.
    for (const className of declareContainers) {
      bindings.push({ type: "durable_object_namespace", name: className, class_name: className });
    }
  }

  for (const [name, value] of Object.entries(vars)) {
    bindings.push({ type: "plain_text", name, text: value });
  }

  if (recipe.worker.assetsManifest) {
    bindings.push({ type: "assets", name: recipe.worker.assetsBinding || "ASSETS" });
  }

  return bindings;
}
