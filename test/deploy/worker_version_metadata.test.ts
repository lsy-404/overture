import { buildBindings } from "../../src/lib/deploy/bindings";
import { KEEP_BINDING_TYPES, uploadWorkerVersion } from "../../src/lib/deploy/workerVersion";
import type { Recipe } from "../../src/lib/recipe/types";

const recipe = {
  resources: [],
  worker: {
    defaultName: "x",
    module: "worker/index.js",
    durableObjects: [{ binding: "ROOM_DO", className: "RoomDO", storage: "sqlite" }],
    assetsRouting: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
  },
} as Recipe;
const base = { recipe, mode: "fresh" as const, resourceIds: {}, resourceNames: {}, vars: {}, declareContainers: [] };
const bindings = buildBindings(base);
const captured: Array<Record<string, unknown>> = [];
const oldFetch = globalThis.fetch;

try {
  globalThis.fetch = async (_input, init) => {
    const form = init?.body as FormData;
    captured.push(JSON.parse(await (form.get("metadata") as Blob).text()));
    return new Response(JSON.stringify({ success: true, result: { id: "version" } }), { status: 200 });
  };
  for (const mode of ["fresh", "overwrite"] as const) {
    await uploadWorkerVersion({
      accountId: "a",
      script: "x",
      workerModule: "worker/index.js",
      workerBytes: new Uint8Array([1]),
      bindings,
      containers: [],
      durableObjects: recipe.worker.durableObjects,
      assetsRouting: recipe.worker.assetsRouting,
      assetJwt: "asset-jwt",
      assetHeaders: "/assets/*\n  Cache-Control: public, max-age=31536000",
      mode,
    });
  }
} finally {
  globalThis.fetch = oldFetch;
}

const expectedExport = { RoomDO: { type: "durable-object", storage: "sqlite" } };
const expectedAssets = {
  jwt: "asset-jwt",
  config: {
    _headers: "/assets/*\n  Cache-Control: public, max-age=31536000",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*"],
  },
};
const checks: Array<[string, boolean]> = [
  ["bindings preserve explicit binding and class", bindings.some((entry) =>
    entry.type === "durable_object_namespace" && entry.name === "ROOM_DO" && entry.class_name === "RoomDO")],
  ["fresh and overwrite uploads both declare the Durable Object export",
    captured.length === 2 && captured.every((metadata) => JSON.stringify(metadata.exports) === JSON.stringify(expectedExport))],
  ["assets routing is snake_case and merges with _headers without loss",
    captured.every((metadata) => JSON.stringify(metadata.assets) === JSON.stringify(expectedAssets))],
  ["overwrite retains existing bindings", JSON.stringify(captured[1]?.keep_bindings) === JSON.stringify(KEEP_BINDING_TYPES)],
  ["fresh upload does not request keep_bindings", captured[0]?.keep_bindings === undefined],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

if (failures > 0) process.exit(1);
