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

import { defineStore } from "pinia";
import { computed, markRaw, ref, watch } from "vue";
import type { GithubRelease, SourceRef } from "../../shared/package";
import type { LoadedConfig } from "../lib/package/config";
import type { DataPackage } from "../lib/package/artifact";
import type { PackageAnalysis } from "../lib/analyze/analyze";
import type { Recipe, RecipeResource } from "../lib/recipe/types";
import {
  HOST_STEP_HEALTH,
  type DeployCredentials,
  type DeployMode,
  type DeployResult,
  type DeployTarget,
  type ExistingResource,
  type LiveScriptFacts,
  type StepState,
  type StepStatus,
} from "../lib/deploy/types";
import { matchResource, type ResourceMatch } from "../lib/deploy/match";

/** Wizard page numbers, in the order the user walks them. */
export const STEPS = {
  tos: 1,
  version: 2,
  credentials: 3,
  target: 4,
  confirm: 5,
  deploy: 6,
  done: 7,
} as const;

export const TOTAL_STEPS = STEPS.done;

const CREDS_KEY = "overture_creds";

function emptyCredentials(): DeployCredentials {
  return { accountId: "", apiToken: "", r2AccessKeyId: "", r2SecretAccessKey: "" };
}

function loadCredentials(): DeployCredentials {
  try {
    const raw = sessionStorage.getItem(CREDS_KEY);
    if (!raw) return emptyCredentials();
    return { ...emptyCredentials(), ...(JSON.parse(raw) as Partial<DeployCredentials>) };
  } catch {
    return emptyCredentials();
  }
}

function emptyLive(): LiveScriptFacts {
  return { exists: false, vars: {}, crons: [], customDomains: [], containerClasses: [] };
}

export const useWizard = defineStore("wizard", () => {
  const step = ref<number>(STEPS.tos);

  function goTo(target: number) {
    step.value = target;
  }

  // ---- tool terms ---------------------------------------------------------
  const tosAccepted = ref(false);

  // ---- source & version ---------------------------------------------------
  const source = ref<SourceRef | null>(null);
  /** The source came from `?src=`, so the picker is not offered. */
  const sourcePinned = ref(false);

  const releases = ref<GithubRelease[]>([]);
  const selectedTag = ref("");
  const config = ref<LoadedConfig | null>(null);
  const recipe = computed<Recipe | null>(() => config.value?.recipe ?? null);

  // The data package is fetched as soon as a release is picked rather than at
  // deploy time: the analysis below reads its recipe.js, and a report the user
  // only sees after pressing deploy would be a report about a decision already
  // made.
  const dataPackage = ref<DataPackage | null>(null);
  const analysis = ref<PackageAnalysis | null>(null);

  function adoptPackage(loaded: DataPackage, report: PackageAnalysis) {
    dataPackage.value = markRaw(loaded);
    analysis.value = markRaw(report);
  }

  /** The install configuration's own licence and terms text, already resolved. */
  const licenseText = computed(() => config.value?.licenseText || "");
  const termsText = computed(() => config.value?.termsText || "");

  function selectedRelease(): GithubRelease | null {
    return releases.value.find((release) => release.tag_name === selectedTag.value) || null;
  }

  const termsAccepted = ref(false);

  // ---- credentials -------------------------------------------------------
  // sessionStorage only: the API token and R2 key pair never outlive the tab,
  // never enter a log line, a URL, or a sandbox message. On a failed deploy the
  // stored copy is dropped while the in-memory one survives, so an immediate
  // retry in the same tab doesn't force retyping everything.
  const credentials = ref<DeployCredentials>(loadCredentials());
  const credentialsVerified = ref(false);
  /** Permission groups the token proved it holds, or null when unreadable. */
  const tokenGroups = ref<Set<string> | null>(null);

  watch(
    credentials,
    (value) => {
      try {
        sessionStorage.setItem(CREDS_KEY, JSON.stringify(value));
      } catch {
        // Private browsing or a full quota — the form still works in memory.
      }
    },
    { deep: true },
  );

  function clearCredentials(wipeMemory: boolean) {
    sessionStorage.removeItem(CREDS_KEY);
    if (wipeMemory) credentials.value = emptyCredentials();
    credentialsVerified.value = false;
    tokenGroups.value = null;
  }

  const needsS3Keys = computed(() =>
    (recipe.value?.resources ?? []).some((resource) => resource.kind === "r2" && !!resource.s3Keys),
  );
  const requiresS3Keys = computed(() =>
    (recipe.value?.resources ?? []).some((resource) => resource.kind === "r2" && resource.s3Keys === "required"),
  );

  // ---- target ------------------------------------------------------------
  const workerName = ref("");
  const resourceNames = ref<Record<string, string>>({});
  /** Resource ids whose name the user edited, so defaults stop following. */
  const touchedResources = ref<Record<string, boolean>>({});
  const inputs = ref<Record<string, string | boolean>>({});
  const live = ref<LiveScriptFacts>(emptyLive());
  const liveRead = ref(false);
  const overwriteConfirmed = ref(false);
  const fullRebuild = ref(false);
  /** Container class name → declare it on the new version. */
  const containerChoices = ref<Record<string, boolean>>({});

  const mode = computed<DeployMode>(() => (live.value.exists ? "overwrite" : "fresh"));

  watch(mode, () => {
    overwriteConfirmed.value = false;
    fullRebuild.value = false;
  });

  // One UUID per deployment, so two vars interpolating ${uuid} agree.
  const deployUuid = crypto.randomUUID();

  function interpolate(template: string, extra: Record<string, string> = {}): string {
    return template.replace(/\$\{([^}]+)\}/g, (whole, token: string) => {
      if (token === "worker") return workerName.value.trim();
      if (token === "version") return recipe.value?.version ?? "";
      if (token === "buildTime") return recipe.value?.buildTime ?? "";
      if (token === "tag") return recipe.value?.tag ?? "";
      if (token === "uuid") return deployUuid;
      if (token === "accountId") return credentials.value.accountId.trim();
      if (token.startsWith("resource:")) return resourceNames.value[token.slice("resource:".length)] ?? "";
      if (token.startsWith("input:")) {
        const value = inputs.value[token.slice("input:".length)];
        return value === undefined ? "" : String(value);
      }
      return extra[token] ?? whole;
    });
  }

  function defaultResourceName(resource: RecipeResource): string {
    return interpolate(resource.defaultName);
  }

  function syncResourceDefaults() {
    for (const resource of recipe.value?.resources ?? []) {
      if (touchedResources.value[resource.id]) continue;
      resourceNames.value[resource.id] = defaultResourceName(resource);
    }
  }

  watch(workerName, syncResourceDefaults);

  function touchResource(id: string) {
    touchedResources.value[id] = true;
    // Editing the name is a new question, so an answer given to the old one
    // stops applying rather than quietly outliving what it was about.
    delete adoptChoice.value[id];
  }

  // ---- what the account already holds -------------------------------------

  /** Resource kind → everything of that kind in the account; null when unreadable. */
  const inventory = ref<Record<string, ExistingResource[] | null>>({});
  /**
   * Resource id → the user's answer when the recipe's pattern matched more than
   * one thing. The name of the resource to adopt, or "" for "create a new one".
   */
  const adoptChoice = ref<Record<string, string>>({});

  /** Resource id → what the recipe's match declaration resolves to right now. */
  const resourceMatches = computed<Record<string, ResourceMatch>>(() => {
    const out: Record<string, ResourceMatch> = {};
    for (const resource of recipe.value?.resources ?? []) {
      const existing = inventory.value[resource.kind];
      const name = (resourceNames.value[resource.id] ?? "").trim();
      // An empty field is the user skipping an optional resource. Matching it
      // anyway would bind the very thing they asked to leave out — and would do
      // it on a line of the page that reads "skipped".
      //
      // An unreadable listing is not an empty account either: with nothing to
      // match against there is no answer, and the options page blocks rather
      // than letting this fall through to "create".
      if (!name || !existing) {
        out[resource.id] = { outcome: "create" };
        continue;
      }
      out[resource.id] = matchResource({ resource, chosenName: name, existing, interpolate });
    }
    return out;
  });

  /** Resource id → the existing resource this deployment will write into. */
  const adoptions = computed<Record<string, ExistingResource>>(() => {
    const out: Record<string, ExistingResource> = {};
    for (const resource of recipe.value?.resources ?? []) {
      const match = resourceMatches.value[resource.id];
      const chosen = adoptChoice.value[resource.id];
      if (chosen !== undefined) {
        const entry = (inventory.value[resource.kind] || []).find((candidate) => candidate.name === chosen);
        if (entry) out[resource.id] = entry;
        continue;
      }
      if (match?.outcome === "adopt" && match.adopt) out[resource.id] = match.adopt;
    }
    return out;
  });

  /**
   * A pattern that matched several resources is the one case the wizard will not
   * settle on its own, because settling it wrong means writing into data that
   * belongs to something else.
   */
  const undecidedResources = computed(() =>
    (recipe.value?.resources ?? [])
      .filter((resource) => resourceMatches.value[resource.id]?.outcome === "ambiguous")
      .filter((resource) => adoptChoice.value[resource.id] === undefined)
      .map((resource) => resource.id),
  );

  function chooseAdoption(resourceId: string, name: string) {
    adoptChoice.value[resourceId] = name;
  }

  function clearAdoption(resourceId: string) {
    delete adoptChoice.value[resourceId];
  }

  /**
   * The name this deployment actually uses for a resource: an adopted one keeps
   * its own name, whatever the field says. Everything downstream reads this —
   * the bindings, the `${resource:id}` vars, what the sandbox is told, and the
   * review page — so there is one name per resource rather than two that can
   * disagree about which thing is being written into.
   */
  const effectiveResourceNames = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const resource of recipe.value?.resources ?? []) {
      const adopted = adoptions.value[resource.id];
      out[resource.id] = adopted ? adopted.name : (resourceNames.value[resource.id] ?? "").trim();
    }
    return out;
  });

  /**
   * Resources set to create under a name the account already holds. Provisioning
   * no longer looks before it creates, so Cloudflare would refuse this halfway
   * through a deployment; it is the options page's job to catch it.
   */
  const collidingResources = computed(() =>
    (recipe.value?.resources ?? [])
      .filter((resource) => {
        const existing = inventory.value[resource.kind];
        const name = (resourceNames.value[resource.id] ?? "").trim();
        if (!existing || !name || adoptions.value[resource.id]) return false;
        return existing.some((entry) => entry.name === name);
      })
      .map((resource) => resource.id),
  );

  /** Fills every target field from the recipe's own defaults. */
  function adoptConfig(loaded: LoadedConfig) {
    // Raw, not reactive: the recipe object is large and read-only once loaded,
    // and a reactive proxy of it would be cloned into the sandbox message.
    config.value = markRaw(loaded);
    dataPackage.value = null;
    analysis.value = null;
    termsAccepted.value = false;
    workerName.value = loaded.recipe.worker.defaultName;
    touchedResources.value = {};
    resourceNames.value = {};
    syncResourceDefaults();
    inventory.value = {};
    adoptChoice.value = {};
    inputs.value = {};
    for (const input of loaded.recipe.inputs ?? []) {
      inputs.value[input.id] = input.default ?? (input.kind === "toggle" ? false : "");
    }
    containerChoices.value = {};
    for (const container of loaded.recipe.worker.containers ?? []) {
      containerChoices.value[container.className] = container.mode === "always";
    }
    live.value = emptyLive();
    liveRead.value = false;
    resetExecution();
  }

  /** Applies live-script facts, defaulting "ask" containers to what is there. */
  function applyLive(facts: LiveScriptFacts) {
    live.value = facts;
    liveRead.value = true;
    for (const container of recipe.value?.worker.containers ?? []) {
      if (container.mode === "ask") {
        containerChoices.value[container.className] = facts.containerClasses.includes(container.className);
      }
    }
  }

  const declareContainers = computed(() =>
    (recipe.value?.worker.containers ?? [])
      .filter((container) => container.mode === "always" || (container.mode === "ask" && containerChoices.value[container.className]))
      .map((container) => container.className),
  );

  /** Inputs the recipe declares for the mode the deploy is actually in. */
  const activeInputs = computed(() =>
    (recipe.value?.inputs ?? []).filter((input) => !input.onlyMode || input.onlyMode === mode.value),
  );

  const domainValue = computed(() => {
    const domainInput = activeInputs.value.find((input) => input.kind === "domain");
    const value = domainInput ? inputs.value[domainInput.id] : "";
    return typeof value === "string" ? value.trim() : "";
  });

  function buildTarget(): DeployTarget {
    const names: Record<string, string> = { ...effectiveResourceNames.value };
    const values: Record<string, string | boolean> = {};
    for (const input of activeInputs.value) {
      const value = inputs.value[input.id];
      values[input.id] = typeof value === "string" ? value.trim() : value ?? false;
    }
    return {
      mode: mode.value,
      workerName: workerName.value.trim(),
      resourceNames: names,
      adopted: { ...adoptions.value },
      inputs: values,
      declareContainers: declareContainers.value,
      fullRebuild: mode.value === "overwrite" && fullRebuild.value,
      domain: domainValue.value,
    };
  }

  // ---- execution ---------------------------------------------------------
  const stepStates = ref<StepState[]>([]);
  const result = ref<DeployResult | null>(null);
  const deployFailed = ref(false);
  const failedStep = ref("");
  const failedMessage = ref("");

  /**
   * The execution checklist, in the order it is always shown: the recipe's own
   * steps, then the host's health probe when the recipe declares one.
   */
  const checklist = computed<Array<{ id: string; weight: number }>>(() => {
    const current = recipe.value;
    if (!current) return [];
    const entries: Array<{ id: string; weight: number }> = [];
    for (const step of current.steps) {
      entries.push({ id: step.id, weight: step.weight && step.weight > 0 ? step.weight : 1 });
    }
    if (current.health) entries.push({ id: HOST_STEP_HEALTH, weight: 1 });
    return entries;
  });

  function resetExecution() {
    stepStates.value = checklist.value.map((entry) => ({ id: entry.id, status: "pending" as StepStatus }));
    result.value = null;
    deployFailed.value = false;
    failedStep.value = "";
    failedMessage.value = "";
  }

  function setStepStatus(id: string, status: StepStatus, detail?: string) {
    let entry = stepStates.value.find((state) => state.id === id);
    // A step the checklist didn't predict still has to be visible rather than
    // silently dropped.
    if (!entry) {
      entry = { id, status };
      stepStates.value.push(entry);
    }
    entry.status = status;
    entry.detail = detail;
    if (status !== "running") entry.progress = undefined;
    if (status === "failed") {
      deployFailed.value = true;
      if (!failedStep.value) failedStep.value = id;
    }
  }

  function setStepProgress(id: string, fraction: number) {
    const entry = stepStates.value.find((state) => state.id === id);
    if (entry) entry.progress = Math.min(1, Math.max(0, fraction));
  }

  /** Fraction of the declared checklist weight that has completed. */
  const executeProgress = computed(() => {
    let total = 0;
    let done = 0;
    for (const state of stepStates.value) {
      const weight = checklist.value.find((entry) => entry.id === state.id)?.weight ?? 1;
      total += weight;
      if (state.status === "success" || state.status === "skipped") done += weight;
      else if (state.status === "running") done += weight * (state.progress ?? 0.5);
    }
    return total === 0 ? 0 : done / total;
  });

  function finishFailure() {
    clearCredentials(false);
  }

  return {
    step,
    goTo,
    tosAccepted,
    source,
    sourcePinned,
    releases,
    selectedTag,
    config,
    recipe,
    dataPackage,
    analysis,
    adoptPackage,
    licenseText,
    termsText,
    selectedRelease,
    adoptConfig,
    termsAccepted,
    credentials,
    credentialsVerified,
    tokenGroups,
    clearCredentials,
    needsS3Keys,
    requiresS3Keys,
    workerName,
    resourceNames,
    touchResource,
    defaultResourceName,
    inventory,
    resourceMatches,
    adoptions,
    effectiveResourceNames,
    undecidedResources,
    collidingResources,
    chooseAdoption,
    clearAdoption,
    inputs,
    activeInputs,
    domainValue,
    live,
    liveRead,
    applyLive,
    mode,
    overwriteConfirmed,
    fullRebuild,
    containerChoices,
    declareContainers,
    interpolate,
    buildTarget,
    checklist,
    stepStates,
    result,
    deployFailed,
    failedStep,
    failedMessage,
    resetExecution,
    setStepStatus,
    setStepProgress,
    executeProgress,
    finishFailure,
  };
});
