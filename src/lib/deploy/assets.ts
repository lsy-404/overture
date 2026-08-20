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

// Cloudflare's two-phase asset protocol: open a session with the manifest,
// then upload only the buckets of hashes it asks for. Opening the session is
// an ordinary session-cookie call; the completion call is authorized with the
// session's own short-lived JWT instead — the one relay call that carries an
// explicit `Authorization` header, since that JWT was never a secret the SPA
// had to be kept from seeing.

import { callCfJson, callCfMultipartBearer } from "../relay";

const MAX_ASSET_BYTES = 16 * 1024 * 1024;

interface AssetEntry {
  hash: string;
  size: number;
}

export type AssetManifest = Record<string, AssetEntry>;

export interface UploadAssetsInput {
  accountId: string;
  script: string;
  /** Package files, keyed by package-relative path. */
  files: Map<string, Uint8Array>;
  /** The package's Cloudflare asset manifest, keyed by served path. */
  manifest: AssetManifest;
  /** Package-relative directory the manifest's paths resolve against. */
  assetsDir: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function assetFileName(assetsDir: string, assetPath: string): string {
  const clean = assetPath.replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.includes("\\")) throw new Error("Invalid asset path in the package manifest");
  const dir = assetsDir.replace(/^\/+|\/+$/g, "");
  return dir ? `${dir}/${clean}` : clean;
}

function assetContentType(assetPath: string): string {
  const extension = assetPath.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "js":
    case "mjs": return "text/javascript";
    case "css": return "text/css";
    case "html": return "text/html";
    case "json": return "application/json";
    case "webmanifest": return "application/manifest+json";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "ico": return "image/x-icon";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

/** Returns the completion JWT the version upload has to carry. */
export async function uploadAssets(input: UploadAssetsInput): Promise<string> {
  const { accountId, script, files, manifest, assetsDir, onProgress, signal } = input;
  const hashes = new Map<string, { path: string; entry: AssetEntry }>();
  let totalBytes = 0;
  for (const [assetPath, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry.hash !== "string" || !/^[0-9a-f]{32}$/i.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error("Invalid asset manifest");
    }
    const bytes = files.get(assetFileName(assetsDir, assetPath));
    if (!bytes || bytes.byteLength !== entry.size) throw new Error(`Asset is missing or has an invalid size: ${assetPath}`);
    totalBytes += bytes.byteLength;
    hashes.set(entry.hash, { path: assetPath, entry });
  }
  if (totalBytes > MAX_ASSET_BYTES) throw new Error("Static assets exceed the upload size limit");

  const session = await callCfJson<{ jwt?: string; buckets?: string[][] }>(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/assets-upload-session`,
    { method: "POST", body: JSON.stringify({ manifest }), signal },
    "Workers Scripts Write",
  );
  let completionJwt = session.jwt || "";
  const buckets = (session.buckets || []).filter((bucket) => Array.isArray(bucket) && bucket.length > 0);
  // Cloudflare only asks for hashes it doesn't already store, so progress is
  // measured against what it actually requested rather than the whole manifest.
  const bucketBytes = buckets.map((bucket) => bucket.reduce((sum, hash) => sum + (hashes.get(hash)?.entry.size || 0), 0));
  const requestedBytes = bucketBytes.reduce((sum, size) => sum + size, 0);
  let uploadedBytes = 0;
  onProgress?.(0, requestedBytes);
  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index];
    if (!completionJwt) throw new Error("Cloudflare did not return an asset upload token");
    const form = new FormData();
    for (const hash of bucket) {
      const found = hashes.get(hash);
      if (!found) throw new Error("Cloudflare requested an unknown asset hash");
      const bytes = files.get(assetFileName(assetsDir, found.path));
      if (!bytes) throw new Error(`Asset disappeared during upload: ${found.path}`);
      form.append(hash, new File([base64Bytes(bytes)], hash, { type: assetContentType(found.path) }));
    }
    const result = await callCfMultipartBearer<{ jwt?: string }>(
      completionJwt,
      `/accounts/${accountId}/workers/assets/upload?base64=true`,
      form,
      "Workers Scripts Write",
      signal,
    );
    if (result.jwt) completionJwt = result.jwt;
    uploadedBytes += bucketBytes[index];
    onProgress?.(uploadedBytes, requestedBytes);
  }
  if (!completionJwt) throw new Error("Cloudflare did not return a completed asset upload token");
  return completionJwt;
}
