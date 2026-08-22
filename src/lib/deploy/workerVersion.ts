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

import type { Binding } from "./bindings";
import type { DeployMode } from "./types";
import { callCfJson, callCfMultipart, callCfNoContent } from "../relay";

const CONTEXT = "Workers Scripts Write";

/** Types an overwrite carries forward from the live version instead of re-declaring. */
export const KEEP_BINDING_TYPES = [
  "plain_text",
  "json",
  "secret_text",
  "secret_key",
  "kv_namespace",
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "images",
  "assets",
];

export interface UploadVersionInput {
  accountId: string;
  script: string;
  /** Package-relative path of the ESM entry, used verbatim as the module name. */
  workerModule: string;
  workerBytes: Uint8Array;
  /** Built by buildBindings — this function never invents one. */
  bindings: Binding[];
  /** Container class names to declare, empty when the script has none. */
  containers: string[];
  /** Completion JWT from the asset upload; omitted when the package ships no assets. */
  assetJwt?: string;
  /** Contents of the package's `_headers` file, parsed by Cloudflare server-side. */
  assetHeaders?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mode: DeployMode;
}

export async function uploadWorkerVersion(input: UploadVersionInput, signal?: AbortSignal): Promise<string> {
  const metadata: Record<string, unknown> = {
    main_module: input.workerModule,
    bindings: input.bindings,
    compatibility_date: input.compatibilityDate || "2025-05-24",
    compatibility_flags: input.compatibilityFlags || ["nodejs_compat"],
  };

  if (input.assetJwt) {
    const assets: Record<string, unknown> = { jwt: input.assetJwt };
    // `_headers` is the only way to repair assets whose stored content type is
    // empty: those are deduplicated by hash and never re-uploaded.
    if (input.assetHeaders) assets.config = { _headers: input.assetHeaders };
    metadata.assets = assets;
  }

  if (input.mode === "overwrite") metadata.keep_bindings = KEEP_BINDING_TYPES;

  // A script that already has a container's Durable Object registered orphans it
  // when a new version omits the class; declaring one the script never had is
  // rejected instead. So the caller decides, from the live script's own state.
  if (input.containers.length > 0) metadata.containers = input.containers.map((className) => ({ class_name: className }));

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata");
  form.append(
    input.workerModule,
    new Blob([input.workerBytes.buffer as ArrayBuffer], { type: "application/javascript+module" }),
    input.workerModule,
  );

  const result = await callCfMultipart<{ id?: string }>(
    `/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(input.script)}/versions`,
    form,
    CONTEXT,
    signal,
  );
  if (!result.id) throw new Error("Cloudflare did not return a Worker version id");
  return result.id;
}

export async function switchTraffic(accountId: string, script: string, versionId: string, signal?: AbortSignal): Promise<void> {
  await callCfJson(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`,
    { method: "POST", body: JSON.stringify({ strategy: "percentage", versions: [{ percentage: 100, version_id: versionId }] }), signal },
    CONTEXT,
  );
}

export interface UploadedVersionBinding {
  type?: string;
  class_name?: string;
  namespace_id?: string;
}

/** Read after traffic changes so a Container application can bind the new DO namespace. */
export async function readUploadedVersion(accountId: string, script: string, versionId: string, signal?: AbortSignal): Promise<UploadedVersionBinding[]> {
  const result = await callCfJson<{ resources?: { bindings?: UploadedVersionBinding[] } }>(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/versions/${encodeURIComponent(versionId)}`,
    signal ? { signal } : undefined,
    CONTEXT,
  );
  return result.resources?.bindings || [];
}

export async function listScriptNames(accountId: string, signal?: AbortSignal): Promise<string[]> {
  const list = await callCfJson<Array<{ id?: string }>>(`/accounts/${accountId}/workers/scripts`, signal ? { signal } : undefined, CONTEXT);
  return list.map((entry) => entry.id || "").filter(Boolean);
}

export async function readCrons(accountId: string, script: string, signal?: AbortSignal): Promise<string[]> {
  const result = await callCfJson<{ schedules?: Array<{ cron?: string }> }>(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/schedules`,
    signal ? { signal } : undefined,
    CONTEXT,
  );
  return (result.schedules || []).map((row) => row.cron || "").filter(Boolean);
}

/**
 * Deleting the script drops everything attached to it: bindings, secrets,
 * schedules, Durable Object namespaces, its asset store and its custom domains.
 * D1, R2 and KV are separate resources and survive, so the data is never at
 * risk — but whatever the deploy cannot regenerate has to be read out first.
 */
export async function deleteScript(accountId: string, script: string, signal?: AbortSignal): Promise<void> {
  await callCfNoContent(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}?force=true`,
    { method: "DELETE", signal },
    CONTEXT,
  );
}
