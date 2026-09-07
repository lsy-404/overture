// SPDX-License-Identifier: AGPL-3.0-or-later

import { createCapabilityHost } from "../../src/lib/engine/capabilities";
import type { Recipe } from "../../src/lib/recipe/types";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const calls: Array<{ url: string; method: string }> = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method || "GET";
  calls.push({ url, method });
  if (method === "GET" && url.endsWith("/deployments")) {
    return new Response(JSON.stringify({ success: true, result: { deployments: [{ versions: [{ version_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }] }] } }), { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: true, result: { id: "worker-name" } }), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function main(): Promise<void> {
  try {
    const recipe = {
      resources: [],
      capabilities: ["worker"],
      worker: { module: "worker.js", vars: [] },
      steps: [],
    } as unknown as Recipe;
    const host = createCapabilityHost({
      pkg: { recipe, files: new Map([["worker.js", new Uint8Array([1])]]), tag: "v1" },
      creds: { accountId: ACCOUNT, cfApiToken: "", r2AccessKeyId: "", r2SecretAccessKey: "" },
      target: { mode: "overwrite", workerName: "waline", resourceNames: {}, adopted: {}, inputs: {}, declareContainers: [], fullRebuild: true, domain: "" },
      live: { exists: true, vars: {}, crons: [], customDomains: [], containerClasses: [] },
      deploymentUuid: "uuid",
      onStep: () => {},
      onProgress: () => {},
    });
    await host.invoke("worker.deleteScript", []);
    const result = await host.invoke("worker.uploadVersion", []) as { versionId: string };
    const methods = calls.map((call) => `${call.method} ${call.url}`).join("\n");
    const ok = result.versionId === "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      && calls[0]?.method === "DELETE"
      && calls[1]?.method === "PUT" && calls[1]?.url.endsWith("/workers/scripts/waline")
      && calls[2]?.method === "GET" && calls[2]?.url.endsWith("/workers/scripts/waline/deployments")
      && !methods.includes("/versions");
    if (!ok) {
      console.error(`FAIL full rebuild recreates the Worker before resolving its active version\n${methods}`);
      process.exit(1);
    }
    console.log("PASS full rebuild recreates the Worker before resolving its active version");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
