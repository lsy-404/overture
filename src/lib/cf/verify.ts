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

// The credentials page as a checklist rather than a first-failure stop: a
// half-configured token should tell the user exactly which row to go back and
// fix. Rows are reported as they resolve, so the table fills in progressively.
//
// Row keys: "token" for the credential itself, one per `recipe.checks` entry
// (its `id`), and "r2Keys" when the recipe asks for an R2 S3 key pair. `detail`
// carries Cloudflare's own wording; the caller supplies the localized row labels.
//
// The authority table is not checked here. Which authorities were granted is
// settled at the consent screen, and a credential issued that way cannot read
// its own policies back — the endpoint answers 401 — so there is nothing to
// compare against. What still decides whether a deployment may run is the
// account probes below, which ask the account directly.

import type { Recipe } from "../recipe/types";
import type { DeployCredentials } from "../deploy/types";
import { callCfJson, verifyR2Keys } from "../relay";
import { describeCfError } from "./errors";

export interface CredentialCheck {
  key: string;
  status: "pending" | "checking" | "ok" | "missing" | "error";
  detail?: string;
}

const TOKEN_CONTEXT = "an active Account API Token";

/** A check path is recipe-supplied text, so it is shaped before it reaches the relay. */
function checkPath(template: string, accountId: string): string | null {
  const path = template.replace(/\$\{accountId\}/g, accountId);
  if (!path.startsWith("/") || path.includes("..") || path.includes("//")) return null;
  return path;
}

export async function verifyCredentials(
  creds: DeployCredentials,
  recipe: Recipe,
  report: (check: CredentialCheck) => void,
): Promise<{ ok: boolean }> {
  const { accountId, apiToken } = creds;
  let ok = true;

  report({ key: "token", status: "checking" });
  try {
    await callCfJson(apiToken, `/accounts/${accountId}/tokens/verify`, undefined, TOKEN_CONTEXT);
    report({ key: "token", status: "ok" });
  } catch (error) {
    report({ key: "token", status: "error", detail: describeCfError(error, TOKEN_CONTEXT).message });
    return { ok: false };
  }

  for (const check of recipe.checks || []) {
    const path = checkPath(check.path, accountId);
    if (!path) {
      report({ key: check.id, status: "error", detail: "The recipe declared an unusable check path" });
      if (check.requirement === "required") ok = false;
      continue;
    }
    report({ key: check.id, status: "checking" });
    try {
      await callCfJson(apiToken, path, undefined, check.id);
      report({ key: check.id, status: "ok" });
    } catch (error) {
      const described = describeCfError(error, check.id);
      report({ key: check.id, status: described.r2NotSubscribed ? "missing" : "error", detail: described.message });
      if (check.requirement === "required") ok = false;
    }
  }

  // R2 access keys are S3 credentials of their own: neither the token's policies
  // nor any probe above says anything about them. Verified account-wide rather
  // than per bucket, since the buckets don't exist yet.
  const keyed = recipe.resources.filter((resource) => resource.kind === "r2" && resource.s3Keys);
  if (keyed.length > 0) {
    const required = keyed.some((resource) => resource.s3Keys === "required");
    const accessKeyId = creds.r2AccessKeyId.trim();
    const secretAccessKey = creds.r2SecretAccessKey.trim();
    if (accessKeyId && secretAccessKey) {
      report({ key: "r2Keys", status: "checking" });
      const result = await verifyR2Keys({ accountId, accessKeyId, secretAccessKey });
      report({ key: "r2Keys", status: result.ok ? "ok" : "missing", detail: result.ok ? undefined : result.message });
      if (!result.ok && required) ok = false;
    } else if (required) {
      report({ key: "r2Keys", status: "missing" });
      ok = false;
    } else {
      report({ key: "r2Keys", status: "pending" });
    }
  }

  return { ok };
}
