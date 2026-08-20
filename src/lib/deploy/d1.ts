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

import type { ExistingResource } from "./types";
import { callCfJson } from "../relay";

const CONTEXT = "D1 Write";

interface D1Database {
  uuid?: string;
  name?: string;
}

export async function listDatabases(token: string, accountId: string, signal?: AbortSignal): Promise<ExistingResource[]> {
  const databases = await callCfJson<D1Database[]>(
    token,
    `/accounts/${accountId}/d1/database?per_page=100`,
    signal ? { signal } : undefined,
    CONTEXT,
  );
  return databases
    .filter((database) => database.name && database.uuid)
    .map((database) => ({ name: database.name as string, id: database.uuid as string }));
}

export async function createDatabase(token: string, accountId: string, name: string, signal?: AbortSignal): Promise<string> {
  const created = await callCfJson<D1Database>(
    token,
    `/accounts/${accountId}/d1/database`,
    { method: "POST", body: JSON.stringify({ name }), signal },
    CONTEXT,
  );
  if (!created.uuid) throw new Error("Cloudflare didn't return a database id");
  return created.uuid;
}

// D1's query endpoint accepts a semicolon-joined batch in one call, so a whole
// migration file can be replayed in a single request.
export async function runQuery(
  token: string,
  accountId: string,
  databaseId: string,
  sql: string,
  params?: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  return callCfJson<unknown>(
    token,
    `/accounts/${accountId}/d1/database/${encodeURIComponent(databaseId)}/query`,
    { method: "POST", body: JSON.stringify(params ? { sql, params } : { sql }), signal },
    CONTEXT,
  );
}
