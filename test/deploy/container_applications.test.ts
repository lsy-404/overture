// SPDX-License-Identifier: AGPL-3.0-or-later

import { reconcileContainerApplications, validateContainerPlan } from "../../src/lib/deploy/containerApplications";
import type { DeployTarget } from "../../src/lib/deploy/types";
import type { Recipe } from "../../src/lib/recipe/types";

const recipe = {
  worker: { containers: [{ className: "Sandbox", mode: "ask", image: { reference: `docker.io/wuyilingwei/edgesonic@sha256:${"a".repeat(64)}` } }] },
} as Recipe;
const imageLessRecipe = { worker: { containers: [{ className: "Legacy", mode: "ask" }] } } as Recipe;

function target(action: "on" | "off" | "unchanged", declared = action === "on"): DeployTarget {
  return {
    mode: "overwrite",
    workerName: "edgesonic",
    resourceNames: {}, adopted: {}, inputs: {},
    declareContainers: declared ? ["Sandbox"] : [],
    containerActions: { Sandbox: action },
    fullRebuild: false,
    domain: "",
  };
}

function response(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), { headers: { "Content-Type": "application/json" } });
}

async function rejects(work: () => unknown, pattern: RegExp): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    return pattern.test(error instanceof Error ? error.message : String(error));
  }
}

const originalFetch = globalThis.fetch;
const paths: Array<{ url: string; method: string; body: unknown }> = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method || "GET";
  let body: unknown;
  if (init?.body) body = JSON.parse(String(init.body));
  paths.push({ url, method, body });
  if (method === "GET") return response([]);
  return response({ id: "app-1" });
};

const namespace = [{ type: "durable_object_namespace", class_name: "Sandbox", namespace_id: "do-1" }];
const checks: Array<[string, () => boolean | Promise<boolean>]> = [
  ["an enabled container must be declared before any deployment", () => rejects(() => validateContainerPlan(recipe, target("on", false)), /enabled but is not declared/)],
  ["an enabled container without an image gives an actionable error", () => rejects(() => validateContainerPlan(imageLessRecipe, { ...target("on"), declareContainers: ["Legacy"], containerActions: { Legacy: "on" } }), /cannot be enabled.*immutable image.*Do not declare this container.*keep the existing declaration/)],
  ["unchanged validates without a declaration", () => { validateContainerPlan(recipe, target("unchanged", false)); return true; }],
  ["unchanged makes no Container API request", () => reconcileContainerApplications({ accountId: "a".repeat(32), workerName: "edgesonic", recipe, target: target("unchanged", true), versionBindings: namespace }).then(() => paths.length === 0)],
  ["on creates a named application from the reviewed immutable Docker Hub digest", () => reconcileContainerApplications({ accountId: "a".repeat(32), workerName: "edgesonic", recipe, target: target("on"), versionBindings: namespace }).then(() =>
    paths.length === 2
    && paths[0].url === `/cf/accounts/${"a".repeat(32)}/containers/applications`
    && paths[1].method === "POST"
    && (paths[1].body as { configuration?: { image?: string } }).configuration?.image === `docker.io/wuyilingwei/edgesonic@sha256:${"a".repeat(64)}`
    && (paths[1].body as { name?: string }).name === "edgesonic-sandbox",
  )],
];

let failed = 0;
for (const [name, check] of checks) {
  const ok = await check();
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${name}`);
  } else console.log(`PASS ${name}`);
}
globalThis.fetch = originalFetch;
if (failed) process.exit(1);
