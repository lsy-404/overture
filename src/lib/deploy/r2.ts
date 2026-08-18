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

import { callCfJson } from "../relay";

const CONTEXT = "Workers R2 Storage Write";

interface R2Bucket {
  name?: string;
}

interface R2ListResult {
  buckets?: R2Bucket[];
}

export async function listBucketNames(token: string, accountId: string, signal?: AbortSignal): Promise<string[]> {
  const result = await callCfJson<R2ListResult>(
    token,
    `/accounts/${accountId}/r2/buckets`,
    signal ? { signal } : undefined,
    CONTEXT,
  );
  return (result.buckets || []).map((bucket) => bucket.name || "").filter(Boolean);
}

/** Creating a bucket that already exists is an error, so the name is claimed by listing first. */
export async function getOrCreateBucket(token: string, accountId: string, name: string, signal?: AbortSignal): Promise<void> {
  const names = await listBucketNames(token, accountId, signal);
  if (names.includes(name)) return;
  await callCfJson(
    token,
    `/accounts/${accountId}/r2/buckets`,
    { method: "POST", body: JSON.stringify({ name }), signal },
    CONTEXT,
  );
}
