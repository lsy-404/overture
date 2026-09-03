// SPDX-License-Identifier: AGPL-3.0-or-later

import { createCapabilityHost } from "../../src/lib/engine/capabilities";
import type { Recipe, RecipeTurnstile } from "../../src/lib/recipe/types";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const RECIPE_SECRET = "recipe-turnstile-secret";
const WORKER_SECRET = "worker-turnstile-secret";
const paths: string[] = [];
const widgetBodies: Array<{ name: string; domains: string[] }> = [];
const workerSecrets: Array<{ name: string; text: string }> = [];

const recipe = {
  resources: [],
  turnstiles: [
    { id: "recipe", name: "${worker} contact", domains: ["${input:domain}"], mode: "managed", secret: { target: "recipe" } },
    { id: "worker", name: "Worker contact", domains: ["203.0.113.1"], mode: "invisible", secret: { target: "workerSecret", name: "TURNSTILE_SECRET" } },
  ],
  worker: { vars: [] },
  steps: [{ id: "deploy", label: "Deploy" }],
} as unknown as Recipe;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  paths.push(path);
  if (path.endsWith("/challenges/widgets")) {
    const body = JSON.parse(String(init?.body)) as { name: string };
    widgetBodies.push(body as { name: string; domains: string[] });
    const secret = body.name.includes("contact") && body.name.startsWith("demo") ? RECIPE_SECRET : WORKER_SECRET;
    return new Response(JSON.stringify({ success: true, result: { sitekey: `site-${secret}`, secret } }), { headers: { "Content-Type": "application/json" } });
  }
  if (path.endsWith("/secrets")) {
    workerSecrets.push(JSON.parse(String(init?.body)) as { name: string; text: string });
    return new Response(JSON.stringify({ success: true, result: {} }), { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: false, errors: [{ message: WORKER_SECRET }] }), { status: 400, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function main(): Promise<void> {
  const host = createCapabilityHost({
    pkg: { recipe, files: new Map(), tag: "v1" },
    creds: { accountId: ACCOUNT, cfApiToken: "", r2AccessKeyId: "", r2SecretAccessKey: "" },
    target: { mode: "fresh", workerName: "demo", resourceNames: {}, adopted: {}, inputs: { domain: "app.example.com" }, declareContainers: [], fullRebuild: false, domain: "" },
    live: { exists: false, vars: {}, crons: [], customDomains: [], containerClasses: [] },
    deploymentUuid: "uuid",
    onStep: () => {},
    onProgress: () => {},
  });
  const recipeResult = await host.invoke("turnstile.provision", ["recipe"]) as { sitekey: string; secret?: string };
  const recipeAgain = await host.invoke("turnstile.provision", ["recipe"]) as { sitekey: string; secret?: string };
  const workerResult = await host.invoke("turnstile.provision", ["worker"]) as { sitekey: string; secret?: string };
  await host.pushTurnstileSecrets();
  let unknown = "";
  try {
    await host.invoke("turnstile.provision", ["missing"]);
  } catch (error) {
    unknown = error instanceof Error ? error.message : String(error);
  }
  (recipe.turnstiles as RecipeTurnstile[]).push(
    { id: "invalid", name: "Invalid", domains: ["bad host"], mode: "managed", secret: { target: "recipe" } },
    { id: "duplicate", name: "Duplicate", domains: ["${input:domain}", "app.example.com"], mode: "managed", secret: { target: "recipe" } },
  );
  let invalid = "";
  let duplicate = "";
  try {
    await host.invoke("turnstile.provision", ["invalid"]);
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error);
  }
  try {
    await host.invoke("turnstile.provision", ["duplicate"]);
  } catch (error) {
    duplicate = error instanceof Error ? error.message : String(error);
  }
  let scrubbed = "";
  try {
    await host.invoke("secrets.put", ["OTHER_SECRET", "value"]);
  } catch (error) {
    scrubbed = error instanceof Error ? error.message : String(error);
  }

  const creates = paths.filter((path) => path.endsWith("/challenges/widgets"));
  const checks: Array<[string, boolean, string?]> = [
    ["declared widget names and domains interpolate before creation", creates.length === 2 && widgetBodies[0]?.name === "demo contact" && widgetBodies[0]?.domains.join(",") === "app.example.com", JSON.stringify(widgetBodies)],
    ["recipe-targeted secrets return only to the recipe and are deployment-idempotent", recipeResult.secret === RECIPE_SECRET && recipeAgain.secret === RECIPE_SECRET && recipeResult.sitekey === recipeAgain.sitekey],
    ["Worker-secret target never returns the secret", workerResult.secret === undefined],
    ["Worker-secret target is delivered only through the Worker secret API", workerSecrets.filter((secret) => secret.name === "TURNSTILE_SECRET").length === 1 && workerSecrets.some((secret) => secret.name === "TURNSTILE_SECRET" && secret.text === WORKER_SECRET), JSON.stringify(workerSecrets)],
    ["an undeclared Turnstile widget id is refused", /declares no Turnstile widget/.test(unknown), unknown],
    ["invalid or duplicate final domains are refused before a POST", /not a hostname or IP address/.test(invalid) && /resolve to duplicates/.test(duplicate) && creates.length === 2, `${invalid}; ${duplicate}`],
    ["created Turnstile secrets are scrubbed from later capability errors", !scrubbed.includes(WORKER_SECRET), scrubbed],
  ];
  let failures = 0;
  for (const [label, passed, detail] of checks) {
    if (passed) console.log(`  PASS ${label}`);
    else {
      failures++;
      console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }
  console.log(`${checks.length - failures}/${checks.length} assertions passed`);
  if (failures) process.exit(1);
}

main();
