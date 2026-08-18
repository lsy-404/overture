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
// already owns that title, which is why the title is resolved by listing first.

import { callCfJson } from "../relay";

const CONTEXT = "Workers KV Storage Write";

interface KvNamespace {
  id?: string;
  title?: string;
}

async function listNamespaces(token: string, accountId: string, signal?: AbortSignal): Promise<KvNamespace[]> {
  return callCfJson<KvNamespace[]>(
    token,
    `/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
    signal ? { signal } : undefined,
    CONTEXT,
  );
}

export async function listNamespaceTitles(token: string, accountId: string, signal?: AbortSignal): Promise<string[]> {
  const namespaces = await listNamespaces(token, accountId, signal);
  return namespaces.map((namespace) => namespace.title || "").filter(Boolean);
}

export async function getOrCreateNamespace(token: string, accountId: string, title: string, signal?: AbortSignal): Promise<string> {
  const existing = await listNamespaces(token, accountId, signal);
  const match = existing.find((namespace) => namespace.title === title && namespace.id);
  if (match?.id) return match.id;

  const created = await callCfJson<KvNamespace>(
    token,
    `/accounts/${accountId}/storage/kv/namespaces`,
    { method: "POST", body: JSON.stringify({ title }), signal },
    CONTEXT,
  );
  if (!created.id) throw new Error("Cloudflare didn't return a KV namespace id");
  return created.id;
}
