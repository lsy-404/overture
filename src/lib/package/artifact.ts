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

// The install data package, `overture.tar.gz` — megabytes, fetched only once
// the user presses deploy. Its digest is checked against `recipe.package.sha256`
// before anything is unpacked, which is what ties these bytes to the install
// configuration the user already agreed to.

import { assetOf, MAX_ARTIFACT_BYTES, PACKAGE_ARTIFACT_NAME, type GithubRelease, type SourceRef } from "../../../shared/package";
import { fetchGithubReleaseAsset } from "../relay";
import { sha256Hex } from "./crypto";
import { unpackArtifact } from "./tar";
import { RECIPE_LIMITS, type Recipe } from "../recipe/types";

const DEFAULT_SCRIPT = "recipe.js";

export interface DataPackage {
  files: Map<string, Uint8Array>;
  /** Source text of recipe.js, decoded and size-checked. */
  script: string;
}

export type ByteProgress = (loaded: number, total: number) => void;

async function downloadArtifact(url: string, ref: SourceRef, onProgress?: ByteProgress): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchGithubReleaseAsset(url, ref);
  } catch {
    throw new Error("Install data package download could not reach the relay");
  }
  if (!response.ok) throw new Error(`Install data package download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length") || "0");
  if (length > MAX_ARTIFACT_BYTES) throw new Error("Install data package is too large");
  // Read the body in chunks so a slow download reports real progress instead of
  // an indeterminate spinner. Without a content-length there is nothing to
  // divide by, so fall back to the buffered read.
  if (onProgress && length > 0 && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      loaded += value.byteLength;
      if (loaded > MAX_ARTIFACT_BYTES) throw new Error("Install data package is too large");
      chunks.push(value);
      onProgress(loaded, length);
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("Install data package is too large");
  return bytes;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function readFile(files: Map<string, Uint8Array>, path: string, maxBytes: number, label: string): Uint8Array {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`Install data package is missing ${label} (${path})`);
  if (bytes.byteLength > maxBytes) throw new Error(`${label} (${path}) exceeds ${maxBytes} bytes`);
  return bytes;
}

export async function loadDataPackage(
  ref: SourceRef,
  release: GithubRelease,
  recipe: Recipe,
  onProgress?: ByteProgress,
): Promise<DataPackage> {
  const asset = assetOf(release, PACKAGE_ARTIFACT_NAME, ref);
  if (!asset?.browser_download_url) throw new Error(`Selected release carries no ${PACKAGE_ARTIFACT_NAME}`);

  const bytes = await downloadArtifact(asset.browser_download_url, ref, onProgress);

  const digest = await sha256Hex(bytes);
  if (digest.toLowerCase() !== recipe.package.sha256.toLowerCase()) {
    throw new Error("Install data package checksum doesn't match the install configuration");
  }

  const files = await unpackArtifact(bytes);

  const scriptPath = recipe.script || DEFAULT_SCRIPT;
  const script = decodeUtf8(readFile(files, scriptPath, RECIPE_LIMITS.maxScriptBytes, "recipe script"), "recipe script");

  return { files, script };
}
