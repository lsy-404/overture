// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A container image reference is package configuration, not browser input and
// never a sandbox value. Cloudflare pulls the reviewed public Docker Hub image;
// this code neither uploads an OCI archive nor handles registry credentials.

import { callCfJson } from "../relay";
import type { Recipe, RecipeContainer } from "../recipe/types";
import type { ContainerAction, DeployTarget } from "./types";
import type { UploadedVersionBinding } from "./workerVersion";

const CONTEXT = "Containers";

interface ContainerApplication {
  id?: string;
  name?: string;
  configuration?: Record<string, unknown>;
  max_instances?: number;
  scheduling_policy?: unknown;
  constraints?: unknown;
  affinities?: unknown;
  durable_objects?: { namespace_id?: string };
  rollout_active_grace_period?: number;
}

function actionFor(target: DeployTarget, className: string): ContainerAction {
  return target.containerActions?.[className] || (target.mode === "fresh" ? "on" : "unchanged");
}

function imageReference(container: RecipeContainer): string {
  const value = container.image?.reference;
  if (!value) throw new Error(`Container ${container.className} has no usable reviewed image reference`);
  return value;
}

/** Fails before recipe.js can change anything when an enabled container lacks a reviewed image. */
export function validateContainerPlan(recipe: Recipe, target: DeployTarget): void {
  const declared = new Set(target.declareContainers);
  for (const container of recipe.worker.containers || []) {
    if (actionFor(target, container.className) !== "on") continue;
    if (!declared.has(container.className)) throw new Error(`Container ${container.className} is enabled but is not declared on the Worker version`);
    imageReference(container);
  }
}

function applicationName(workerName: string, className: string): string {
  return `${workerName}-${className}`.toLowerCase();
}

function path(accountId: string, suffix: string): string {
  return `/accounts/${accountId}/containers/applications${suffix}`;
}

function listed(value: ContainerApplication[] | { applications?: ContainerApplication[] }): ContainerApplication[] {
  return Array.isArray(value) ? value : value.applications || [];
}

function namespaceFor(bindings: readonly UploadedVersionBinding[], className: string): string {
  const binding = bindings.find((entry) => entry.type === "durable_object_namespace" && entry.class_name === className && entry.namespace_id);
  if (!binding?.namespace_id) throw new Error(`Uploaded Worker version has no Durable Object namespace for container ${className}`);
  return binding.namespace_id;
}

function desiredConfiguration(existing: ContainerApplication | undefined, image: string): Record<string, unknown> {
  return { ...(existing?.configuration || {}), image, ...(!existing?.configuration ? { instance_type: "lite" } : {}) };
}

/**
 * Runs strictly after a recipe activated its Worker version. `unchanged` is a
 * hard no-op: it does not list, modify, create, or roll out an application.
 * Cloudflare's own deploy order is non-transactional, so callers surface a
 * later failure without claiming the Worker traffic switch was rolled back.
 */
export async function reconcileContainerApplications(input: {
  accountId: string;
  workerName: string;
  recipe: Recipe;
  target: DeployTarget;
  versionBindings: readonly UploadedVersionBinding[];
}): Promise<void> {
  for (const container of input.recipe.worker.containers || []) {
    if (actionFor(input.target, container.className) !== "on") continue;
    const image = imageReference(container);
    const name = applicationName(input.workerName, container.className);
    const applications = listed(await callCfJson<ContainerApplication[] | { applications?: ContainerApplication[] }>(path(input.accountId, ""), undefined, CONTEXT));
    const existing = applications.find((application) => application.name === name);
    const namespaceId = namespaceFor(input.versionBindings, container.className);
    if (existing?.durable_objects?.namespace_id && existing.durable_objects.namespace_id !== namespaceId) {
      throw new Error(`Container application ${name} belongs to a different Durable Object namespace`);
    }
    const configuration = desiredConfiguration(existing, image);
    if (!existing?.id) {
      await callCfJson(path(input.accountId, ""), {
        method: "POST",
        body: JSON.stringify({
          name,
          configuration,
          instances: 0,
          max_instances: 20,
          scheduling_policy: "default",
          constraints: { tiers: [1, 2] },
          durable_objects: { namespace_id: namespaceId },
          rollout_active_grace_period: 0,
        }),
      }, CONTEXT);
      continue;
    }

    const change = {
      configuration,
      max_instances: existing.max_instances ?? 20,
      scheduling_policy: existing.scheduling_policy ?? "default",
      constraints: existing.constraints ?? { tiers: [1, 2] },
      affinities: existing.affinities,
      rollout_active_grace_period: existing.rollout_active_grace_period ?? 0,
    };
    await callCfJson(path(input.accountId, `/${encodeURIComponent(existing.id)}`), { method: "PATCH", body: JSON.stringify(change) }, CONTEXT);
    await callCfJson(path(input.accountId, `/${encodeURIComponent(existing.id)}/rollouts`), {
      method: "POST",
      body: JSON.stringify({
        description: "Overture package deployment",
        strategy: "rolling",
        target_configuration: configuration,
        rollout_step_percentage: 100,
        kind: "full_auto",
      }),
    }, CONTEXT);
  }
}
