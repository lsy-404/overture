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

// One deployment, end to end: assemble what the sandbox is allowed to know, let
// the package's recipe.js drive its own checklist, then do the two things a
// recipe must not be trusted to do for itself — push the host secrets it
// declared required, and check that what it deployed answers.
//
// The data package arrives already fetched, checked against the configuration's
// digest, and read by the analyser: by the time anything here runs, the user has
// been shown what this script is written to do and said yes to it.

import {
  DeployError,
  HOST_STEP_HEALTH,
  type DeployCredentials,
  type DeployResult,
  type DeployTarget,
  type LiveScriptFacts,
  type StepStatus,
} from "../deploy/types";
import { probeReachable } from "../deploy/health";
import type { LoadedConfig } from "../package/config";
import type { DataPackage } from "../package/artifact";
import { effectiveResourceNames } from "../deploy/match";
import { BRIDGE_PROTOCOL, type GuestContext } from "../sandbox/protocol";
import { runSandbox } from "../sandbox/host";
import { createCapabilityHost } from "./capabilities";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runRecipe(input: {
  config: LoadedConfig;
  dataPackage: DataPackage;
  creds: DeployCredentials;
  target: DeployTarget;
  live: LiveScriptFacts;
  locale: string;
  onStep: (id: string, status: StepStatus, detail?: string) => void;
  onProgress: (id: string, fraction: number) => void;
}): Promise<DeployResult> {
  const { config, dataPackage, creds, target, live, locale } = input;
  const recipe = config.recipe;
  // One id for the whole deployment, so two vars using ${uuid} agree.
  const deploymentUuid = crypto.randomUUID();

  const host = createCapabilityHost({
    pkg: { recipe, files: dataPackage.files, tag: config.tag },
    creds,
    target,
    deploymentUuid,
    onStep: input.onStep,
    onProgress: input.onProgress,
  });

  // Exactly the fields GuestContext declares, and no others: no account id, no
  // API token, no R2 key pair. Those stay on this side of the frame boundary and
  // reach the deployed app only as host secrets.
  const context: GuestContext = {
    protocol: BRIDGE_PROTOCOL,
    recipe,
    mode: target.mode,
    workerName: target.workerName,
    // An adopted resource keeps its own name here too: what the script is told
    // it got has to be the thing the Worker is actually bound to.
    resourceNames: effectiveResourceNames(target),
    inputs: { ...target.inputs },
    live,
    declareContainers: [...target.declareContainers],
    fullRebuild: target.fullRebuild,
    domain: target.domain,
    tag: config.tag,
    version: recipe.version,
    buildTime: recipe.buildTime,
    locale,
  };

  const outcome = await runSandbox({ recipe, context, script: dataPackage.script, invoke: host.invoke });
  if (!outcome.ok) throw new DeployError(outcome.step || host.currentStep(), outcome.message || "the recipe failed");

  // A recipe that forgets a secret it declared required ships an app that looks
  // deployed and cannot work, so the host pushes whatever is missing.
  for (const secret of recipe.hostSecrets || []) {
    if (secret.requirement !== "required" || host.pushedHostSecrets().has(secret.name)) continue;
    try {
      await host.pushHostSecret(secret.name);
    } catch (error) {
      throw new DeployError(host.currentStep(), messageOf(error));
    }
  }

  const result = host.result();
  const url = result.url || (target.domain ? `https://${target.domain}` : "");

  if (recipe.health && url) {
    const path = recipe.health.path.startsWith("/") ? recipe.health.path : `/${recipe.health.path}`;
    const probe = `${url.replace(/\/+$/, "")}${path}`;
    input.onStep(HOST_STEP_HEALTH, "running");
    // Reachability only — a cross-origin probe cannot read a status, and the
    // deployment is already established by the traffic switch having succeeded.
    // A dark probe is reported, never fatal.
    const reachable = await probeReachable(probe).then(
      (answer) => answer.ok,
      () => false,
    );
    input.onStep(HOST_STEP_HEALTH, reachable ? "success" : "skipped", reachable ? undefined : "the deployment did not answer yet");
  }

  return {
    workerName: target.workerName,
    version: recipe.version,
    url,
    credentials: result.credentials,
    notes: result.notes,
  };
}
