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

// What the account already holds, read before anything is provisioned: the
// options page needs it to warn about a name collision, and the engine needs the
// live script's own state because a version upload clears schedules and a full
// rebuild deletes the script outright.

import type { DeployCredentials, LiveScriptFacts } from "./types";
import { callCfJson } from "../relay";
import { listDatabaseNames } from "./d1";
import { listBucketNames } from "./r2";
import { listNamespaceTitles } from "./kv";
import { listCustomDomains } from "./domains";
import { listScriptNames, readCrons } from "./workerVersion";

interface ScriptSettings {
  bindings?: Array<{ type?: string; name?: string; text?: string; class_name?: string }>;
}

export async function listExistingNames(creds: DeployCredentials, kind: "d1" | "r2" | "kv"): Promise<string[]> {
  const { apiToken, accountId } = creds;
  switch (kind) {
    case "d1":
      return listDatabaseNames(apiToken, accountId);
    case "r2":
      return listBucketNames(apiToken, accountId);
    case "kv":
      return listNamespaceTitles(apiToken, accountId);
  }
}

export async function readLiveFacts(creds: DeployCredentials, workerName: string): Promise<LiveScriptFacts> {
  const { apiToken, accountId } = creds;
  const empty: LiveScriptFacts = { exists: false, vars: {}, crons: [], customDomains: [], containerClasses: [] };
  if (!workerName) return empty;

  const scripts = await listScriptNames(apiToken, accountId);
  if (!scripts.includes(workerName)) return empty;

  const settings = await callCfJson<ScriptSettings>(
    apiToken,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
    undefined,
    "Workers Scripts Write",
  );
  const bindings = settings.bindings || [];
  const vars: Record<string, string> = {};
  for (const binding of bindings) {
    // Only plain_text carries a readable value; secrets come back without one,
    // which is exactly why an identity a recipe must carry forward has to be a
    // var rather than a secret.
    if (binding.type === "plain_text" && binding.name) vars[binding.name] = binding.text || "";
  }
  const containerClasses = bindings
    .filter((binding) => binding.type === "durable_object_namespace" && binding.class_name)
    .map((binding) => binding.class_name as string);

  // Both reads are advisory: a script can exist with neither schedules nor
  // domains, and neither should sink the run.
  let crons: string[] = [];
  try {
    crons = await readCrons(apiToken, accountId, workerName);
  } catch {
    crons = [];
  }
  let customDomains: string[] = [];
  try {
    customDomains = (await listCustomDomains(apiToken, accountId, workerName)).map((domain) => domain.hostname);
  } catch {
    customDomains = [];
  }

  return { exists: true, vars, crons, customDomains, containerClasses };
}
