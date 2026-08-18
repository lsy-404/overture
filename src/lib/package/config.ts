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

// The install configuration, `overture.json` — small, and fetched as soon as a
// version is picked, so terms, licence and the permission table can render
// before the multi-megabyte data package is anywhere in the picture.

import {
  assetOf,
  MAX_CONFIG_BYTES,
  PACKAGE_CONFIG_NAME,
  tagMatchesVersion,
  type GithubRelease,
  type SourceRef,
} from "../../../shared/package";
import { validateRecipe } from "../recipe/schema";
import type { Recipe } from "../recipe/types";
import { fetchGithubReleaseAsset } from "../relay";

export interface LoadedConfig {
  ref: SourceRef;
  tag: string;
  recipe: Recipe;
  licenseText: string;
  /** The terms text for the caller's locale; empty when the recipe declares none. */
  termsText: string;
}

async function downloadConfig(url: string, ref: SourceRef): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchGithubReleaseAsset(url, ref);
  } catch {
    throw new Error("Install configuration download could not reach the relay");
  }
  if (!response.ok) throw new Error(`Install configuration download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length") || "0");
  if (length > MAX_CONFIG_BYTES) throw new Error("Install configuration is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error("Install configuration is too large");
  return bytes;
}

/** Exact locale, then the `*` fallback, then nothing. */
function pickLocaleText(texts: Record<string, string>, locale: string): string | undefined {
  return texts[locale] ?? texts["*"];
}

export async function loadInstallConfig(ref: SourceRef, release: GithubRelease, locale: string): Promise<LoadedConfig> {
  const asset = assetOf(release, PACKAGE_CONFIG_NAME, ref);
  if (!asset?.browser_download_url) throw new Error(`Selected release carries no ${PACKAGE_CONFIG_NAME}`);

  const bytes = await downloadConfig(asset.browser_download_url, ref);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${PACKAGE_CONFIG_NAME} is not valid JSON`);
  }

  const validated = validateRecipe(parsed);
  if (!validated.ok) {
    throw new Error(`${PACKAGE_CONFIG_NAME} is not a valid install configuration:\n${validated.errors.join("\n")}`);
  }
  const recipe = validated.recipe;

  // The one thing that ties this configuration to the release the user actually
  // picked, rather than one that merely happens to sit beside it.
  const tag = release.tag_name;
  if (!tag || !tagMatchesVersion(tag, recipe.tag)) {
    throw new Error(`${PACKAGE_CONFIG_NAME} is tagged for a different release than the one selected`);
  }

  let termsText = "";
  if (recipe.terms) {
    const picked = pickLocaleText(recipe.terms.texts, locale);
    if (picked !== undefined) {
      termsText = picked;
    } else if (recipe.terms.required) {
      throw new Error(`${PACKAGE_CONFIG_NAME} requires terms acceptance but ships no localized text for this locale`);
    }
  }

  return {
    ref,
    tag,
    recipe,
    licenseText: recipe.license.text,
    termsText,
  };
}
