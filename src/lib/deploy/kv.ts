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

// Checked against the Cloudflare API reference: GET
// /accounts/{id}/storage/kv/namespaces takes `page`/`per_page` and returns
// `{id, title, supports_url_encoding}` rows; POST to the same path takes
// `{title}` and returns the same shape — and answers 400 when the account
// already owns that title, which is why a title is resolved against the
// inventory the options page already read before anything is created.

import type { ExistingResource } from "./types";
import { callCfJson } from "../relay";

const CONTEXT = "Workers KV Storage Write";

interface KvNamespace {
  id?: string;
  title?: string;
}

export async function listNamespaces(accountId: string, signal?: AbortSignal): Promise<ExistingResource[]> {
  const namespaces = await callCfJson<KvNamespace[]>(
    `/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
    signal ? { signal } : undefined,
    CONTEXT,
  );
  return namespaces
    .filter((namespace) => namespace.title && namespace.id)
    .map((namespace) => ({ name: namespace.title as string, id: namespace.id as string }));
}

export async function createNamespace(accountId: string, title: string, signal?: AbortSignal): Promise<string> {
  const created = await callCfJson<KvNamespace>(
    `/accounts/${accountId}/storage/kv/namespaces`,
    { method: "POST", body: JSON.stringify({ title }), signal },
    CONTEXT,
  );
  if (!created.id) throw new Error("Cloudflare didn't return a KV namespace id");
  return created.id;
}
