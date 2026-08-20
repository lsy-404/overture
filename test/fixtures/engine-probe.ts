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

// See engine-probe.html. Everything below the fake relay is the shipping code.

import { runRecipe } from "../../src/lib/engine/run";
import { DeployError, type DeployTarget, type LiveScriptFacts, type StepStatus } from "../../src/lib/deploy/types";
import { BRIDGE_LIMITS } from "../../src/lib/sandbox/protocol";
import type { Recipe } from "../../src/lib/recipe/types";
import type { LoadedConfig } from "../../src/lib/package/config";
import type { DataPackage } from "../../src/lib/package/artifact";

const API_TOKEN = "TOKEN-cf-0123456789abcdefghij";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ASSET_JWT = "JWT-asset-session-9876543210";
const VERSION_ID = "3f2b1c00-0000-4000-8000-abcdefabcdef";

const out = document.getElementById("out") as HTMLElement;
let failures = 0;
out.textContent = "";
function say(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  out.textContent += `${ok ? "PASS  " : "FAIL  "}${name}${detail ? `   ${detail}` : ""}\n`;
}

// --- the fake relay ---------------------------------------------------------

const requests: string[] = [];
const secretsPushed = new Map<string, string>();
/** When set, every /cf call answers with this Cloudflare error message. */
let cfError = "";
/** When set, the reachability probe never answers. */
let hangProbe = false;

function json(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { "content-type": "application/json" } });
}

function route(method: string, path: string, body: string): Response {
  if (cfError) {
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: cfError }] }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (/\/d1\/database\/[^/]+\/query$/.test(path)) return json({ results: [], success: true });
  if (path.includes("/d1/database")) return method === "POST" ? json({ uuid: "d1-uuid-1", name: "probe-db" }) : json([]);
  if (path.includes("/r2/buckets")) return method === "POST" ? json({}) : json({ buckets: [] });
  if (path.includes("/storage/kv/namespaces")) return method === "POST" ? json({ id: "kv-ns-1" }) : json([]);
  if (path.endsWith("/secrets")) {
    const parsed = JSON.parse(body || "{}") as { name?: string; text?: string };
    secretsPushed.set(parsed.name || "", parsed.text || "");
    return json({});
  }
  if (path.endsWith("/assets-upload-session")) return json({ jwt: ASSET_JWT, buckets: [] });
  if (path.endsWith("/versions")) return json({ id: VERSION_ID });
  if (path.endsWith("/deployments")) return json({});
  if (path.endsWith("/schedules")) return method === "PUT" ? json({}) : json({ schedules: [{ cron: "0 * * * *" }] });
  if (path.includes("/workers/domains")) return json([{ hostname: "old.example.com", zone_id: "zone-1", service: "probe-worker" }]);
  if (path.startsWith("/zones")) return json([{ id: "zone-1", name: "example.com" }]);
  if (/\/workers\/scripts\/[^/]+$/.test(path) && method === "DELETE") return new Response("", { status: 200 });
  return new Response(JSON.stringify({ success: false, errors: [{ message: `probe has no route for ${method} ${path}` }] }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method || "GET").toUpperCase();
  requests.push(`${method} ${url}`);
  if (url.includes("/cf/")) {
    const body = typeof init?.body === "string" ? init.body : "";
    return route(method, url.slice(url.indexOf("/cf/") + 3), body);
  }
  // The post-deploy reachability probe.
  if (url.startsWith("https://")) {
    if (hangProbe) return new Promise<Response>(() => {});
    return new Response("", { status: 200 });
  }
  return realFetch(input, init);
};

// --- fake package -----------------------------------------------------------

const encoder = new TextEncoder();

function baseRecipe(): Recipe {
  return {
    schema: 1,
    id: "probe",
    name: "Probe",
    summary: "probe",
    version: "1.0.0",
    tag: "v1.0.0",
    buildTime: "2026-08-19T00:00:00Z",
    package: { artifact: "overture.tar.gz", sha256: "0".repeat(64) },
    license: { id: "AGPL-3.0-or-later", text: "licence" },
    permissions: [],
    resources: [
      { id: "db", kind: "d1", binding: "DB", defaultName: "${worker}-db", required: true, label: "db" },
      { id: "bucket", kind: "r2", binding: "BUCKET", defaultName: "${worker}-store", required: true, label: "bucket" },
      { id: "cache", kind: "kv", binding: "CACHE", defaultName: "${worker}-cache", required: false, label: "cache" },
    ],
    worker: {
      defaultName: "probe-worker",
      module: "worker/index.js",
      assetsManifest: "assets-manifest.json",
      assetsDir: "assets",
      vars: [
        { name: "WORKER_VERSION", value: "${version}" },
        { name: "BUCKET_NAME", value: "${resource:bucket}" },
      ],
    },
    capabilities: ["d1", "r2", "kv", "secrets", "worker", "assets", "cron", "domains", "probe"],
    hostSecrets: [{ name: "CF_API_TOKEN", source: "apiToken", requirement: "required", reason: "self-update" }],
    steps: [
      { id: "prepare", label: "prepare" },
      { id: "upload", label: "upload" },
    ],
    health: { path: "/version" },
  } as Recipe;
}

function config(recipe: Recipe): LoadedConfig {
  return { ref: { owner: "probe", repo: "probe" }, tag: "v1.0.0", recipe, licenseText: "licence", termsText: "" };
}

function dataPackage(script: string): DataPackage {
  const files = new Map<string, Uint8Array>();
  files.set("worker/index.js", encoder.encode("export default { fetch: () => new Response('ok') };"));
  files.set("assets-manifest.json", encoder.encode(JSON.stringify({ "/index.html": { hash: "a".repeat(32), size: 5 } })));
  files.set("assets/index.html", encoder.encode("hello"));
  files.set("migrations/schema.sql", encoder.encode("CREATE TABLE IF NOT EXISTS probe (id INTEGER);"));
  return { files, script };
}

function target(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    mode: "fresh",
    workerName: "probe-worker",
    resourceNames: { db: "probe-db", bucket: "probe-store", cache: "probe-cache" },
    adopted: {},
    inputs: { adminUser: "admin" },
    declareContainers: [],
    fullRebuild: false,
    domain: "",
    ...overrides,
  };
}

const live: LiveScriptFacts = { exists: false, vars: {}, crons: [], customDomains: [], containerClasses: [] };

interface RunOutcome {
  ok: boolean;
  message: string;
  step: string;
  notes: string[];
  url: string;
  version: string;
  credentials: Array<{ label: string; value: string; secret?: boolean }>;
  steps: string[];
}

async function run(recipe: Recipe, script: string, overrides: Partial<DeployTarget> = {}): Promise<RunOutcome> {
  const steps: string[] = [];
  try {
    const result = await runRecipe({
      config: config(recipe),
      dataPackage: dataPackage(script),
      creds: { accountId: ACCOUNT_ID, apiToken: API_TOKEN, r2AccessKeyId: "", r2SecretAccessKey: "" },
      target: target(overrides),
      live,
      locale: "en",
      onStep: (id: string, status: StepStatus, detail?: string) => steps.push(`${id}:${status}${detail ? `:${detail}` : ""}`),
      onProgress: () => {},
    });
    return { ok: true, message: "", step: "", notes: result.notes, url: result.url, version: result.version, credentials: result.credentials, steps };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message,
      step: error instanceof DeployError ? error.step : "",
      notes: [],
      url: "",
      version: "",
      credentials: [],
      steps,
    };
  }
}

/** A recipe that reports whatever `body` returns as a result note. */
function reporting(body: string): string {
  return `export async function deploy(ctx) {
    await ctx.step("prepare", "running");
    const notes = [];
    ${body}
    await ctx.result({ notes });
    await ctx.step("prepare", "success");
  }`;
}

// --- scenarios --------------------------------------------------------------

async function main(): Promise<void> {
  // 1. The whole surface, once through.
  const happy = await run(
    baseRecipe(),
    `export async function deploy(ctx) {
      await ctx.step("prepare", "running");
      const { databaseId } = await ctx.d1.provision("db");
      const { bucketName } = await ctx.r2.provision("bucket");
      const { namespaceId } = await ctx.kv.provision("cache");
      await ctx.d1.query("db", await ctx.text("migrations/schema.sql"));
      const password = await ctx.crypto.password(12);
      const digest = await ctx.crypto.sha256Hex("abc");
      const uuid = await ctx.crypto.uuid();
      const random = await ctx.crypto.randomBase64(16);
      const workerBytes = await ctx.file("worker/index.js");
      await ctx.secrets.put("ADMIN_PASSWORD", password);
      const pushed = await ctx.secrets.putHostValue("CF_API_TOKEN");
      await ctx.step("prepare", "success", "database " + databaseId);

      await ctx.step("upload", "running");
      await ctx.progress("upload", 0.25);
      const handle = await ctx.assets.upload();
      const { versionId } = await ctx.worker.uploadVersion({ assets: handle, extraVars: { EXTRA_VAR: "1" } });
      await ctx.worker.switchTraffic(versionId);
      const crons = await ctx.cron.read();
      await ctx.cron.set(crons);
      const domains = await ctx.domains.list();
      const reach = await ctx.probe.reachable("https://app.example.com/version");
      await ctx.step("upload", "success");

      await ctx.result({
        url: "https://app.example.com",
        credentials: [{ label: "Password", value: password, secret: true }],
        notes: [
          "db=" + databaseId,
          "bucket=" + bucketName,
          "ns=" + namespaceId,
          "handle=" + handle,
          "hostValue=" + JSON.stringify(pushed),
          "digest=" + digest.slice(0, 8),
          "uuid=" + uuid.length,
          "random=" + random.length,
          "bytes=" + workerBytes.byteLength,
          "crons=" + crons.join("|"),
          "domains=" + domains.join("|"),
          "reach=" + JSON.stringify(reach),
          "ctxKeys=" + Object.keys(ctx.ctx).sort().join(","),
        ],
      });
    }`,
  );
  const notes = happy.notes.join(" ");
  say("a whole deployment runs", happy.ok, happy.ok ? happy.url : happy.message);
  say("resources come back provisioned", notes.includes("db=d1-uuid-1") && notes.includes("bucket=probe-store") && notes.includes("ns=kv-ns-1"), notes);
  say("the asset session is an opaque handle", notes.includes("handle=assets-1") && !notes.includes(ASSET_JWT), notes);
  say("putHostValue answers without the value", notes.includes("hostValue=undefined"), notes);
  say("the host pushed the real token", secretsPushed.get("CF_API_TOKEN") === API_TOKEN, String(secretsPushed.has("CF_API_TOKEN")));
  say(
    "the sandbox context carries no credentials",
    !/accountId|apiToken|r2Access|r2Secret/.test(notes.slice(notes.indexOf("ctxKeys="))),
    notes.slice(notes.indexOf("ctxKeys=")),
  );
  say("the recipe drove its own checklist", happy.steps.join(" ").includes("prepare:success:database d1-uuid-1") && happy.steps.includes("upload:success"), happy.steps.join(" "));
  say("the health probe ran on the host step", happy.steps.some((entry) => entry.startsWith("@health:success")), happy.steps.join(" "));
  say("the frame is destroyed afterwards", document.querySelectorAll("iframe").length === 0, `${document.querySelectorAll("iframe").length} left`);

  // 2. Isolation, reported from inside the frame.
  const isolation = await run(
    baseRecipe(),
    reporting(`
      try { void parent.document.title; notes.push("dom=LEAK"); } catch (e) { notes.push("dom=blocked:" + e.name); }
      try { void parent.sessionStorage.length; notes.push("storage=LEAK"); } catch (e) { notes.push("storage=blocked:" + e.name); }
      try { void top.location.href; notes.push("location=LEAK"); } catch (e) { notes.push("location=blocked:" + e.name); }
      try { await fetch(location.origin + "/cf/accounts"); notes.push("net=LEAK"); } catch (e) { notes.push("net=blocked"); }
    `),
  );
  const isolated = isolation.notes.join(" ");
  say("the guest cannot read host DOM, storage or location", isolation.ok && !isolated.includes("LEAK"), isolated);

  // 3. Undeclared capability.
  const noKv = baseRecipe();
  noKv.capabilities = ["d1"];
  const denied = await run(noKv, `export async function deploy(ctx) { await ctx.kv.provision("cache"); }`);
  say("an undeclared capability is refused", !denied.ok && /does not declare the "kv" capability/.test(denied.message), denied.message);

  // 4. Resource checks.
  const wrongKind = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.d1.provision("bucket"); }`);
  say("a resource of the wrong kind is refused", !wrongKind.ok && /is r2, not d1/.test(wrongKind.message), wrongKind.message);

  const unknown = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.d1.provision("nope"); }`);
  say("an undeclared resource is refused", !unknown.ok && /declares no resource/.test(unknown.message), unknown.message);

  const unprovisioned = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.d1.query("db", "SELECT 1"); }`);
  say("a query before provisioning is refused", !unprovisioned.ok && /has not been provisioned/.test(unprovisioned.message), unprovisioned.message);

  // 5. Package paths.
  const escape = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.text("../../etc/passwd"); }`);
  say("a path leaving the package is refused", !escape.ok && /not a package-relative path/.test(escape.message), escape.message);

  // 6. Version and var boundaries.
  const foreign = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.worker.switchTraffic("00000000-0000-4000-8000-000000000000"); }`);
  say("switching to a foreign version is refused", !foreign.ok && /version this deployment uploaded/.test(foreign.message), foreign.message);

  const collision = await run(
    baseRecipe(),
    `export async function deploy(ctx) { await ctx.worker.uploadVersion({ extraVars: { WORKER_VERSION: "hijacked" } }); }`,
  );
  say("redefining a declared var is refused", !collision.ok && /already declares the var/.test(collision.message), collision.message);

  const badVarName = await run(
    baseRecipe(),
    `export async function deploy(ctx) { await ctx.worker.uploadVersion({ extraVars: { "bad name": "x" } }); }`,
  );
  say("an unusable var name is refused", !badVarName.ok && /not a usable var name/.test(badVarName.message), badVarName.message);

  // 7. Script deletion without the user's rebuild choice.
  const rebuild = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.worker.deleteScript(); }`);
  say("deleting the Worker needs the rebuild option", !rebuild.ok && /full-rebuild option/.test(rebuild.message), rebuild.message);

  // 8. Undeclared host secret.
  const foreignSecret = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.secrets.putHostValue("SOMEONE_ELSES"); }`);
  say("an undeclared host secret is refused", !foreignSecret.ok && /declares no host secret/.test(foreignSecret.message), foreignSecret.message);

  // 9. Cloudflare error text is scrubbed on the way out, whether it is the
  // recipe reading it or the wizard reporting it.
  cfError = `Bad request for account ${ACCOUNT_ID} with token ${API_TOKEN}`;
  const quiet = baseRecipe();
  quiet.hostSecrets = [];
  const scrubbed = await run(
    quiet,
    reporting(`
      try { await ctx.d1.provision("db"); notes.push("cf=no-error"); }
      catch (e) { notes.push("cf=" + e.message); }
    `),
  );
  const seenByGuest = scrubbed.notes.join(" ");
  say(
    "Cloudflare error text reaches the recipe scrubbed",
    scrubbed.ok && seenByGuest.includes("[redacted]") && !seenByGuest.includes(API_TOKEN) && !seenByGuest.includes(ACCOUNT_ID),
    seenByGuest,
  );

  const hostSideFailure = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.step("prepare", "success"); }`);
  cfError = "";
  say(
    "a host-side failure is scrubbed too",
    !hostSideFailure.ok && !hostSideFailure.message.includes(API_TOKEN) && !hostSideFailure.message.includes(ACCOUNT_ID) && hostSideFailure.message.includes("[redacted]"),
    hostSideFailure.message,
  );

  // 10. Budgets.
  const tooManyCalls = await run(
    baseRecipe(),
    `export async function deploy(ctx) { for (let i = 0; i < 2100; i++) await ctx.crypto.uuid(); }`,
  );
  say("the call budget stops a runaway recipe", !tooManyCalls.ok && /capability calls than its budget/.test(tooManyCalls.message), tooManyCalls.message);

  const tooBig = await run(
    baseRecipe(),
    `export async function deploy(ctx) { await ctx.secrets.put("BIG", "a".repeat(3000000)); }`,
  );
  say("the payload budget stops an oversized call", !tooBig.ok && /argument budget/.test(tooBig.message), tooBig.message);

  const failedStep = await run(
    baseRecipe(),
    `export async function deploy(ctx) { await ctx.step("upload", "running"); throw new Error("recipe gave up"); }`,
  );
  say("a thrown failure names the running step", !failedStep.ok && failedStep.step === "upload" && /recipe gave up/.test(failedStep.message), `${failedStep.step}: ${failedStep.message}`);

  const noExport = await run(baseRecipe(), `export const nothing = 1;`);
  say("a package without deploy() fails cleanly", !noExport.ok && /export a deploy/.test(noExport.message), noExport.message);

  // 11. A required host secret the recipe never pushed.
  secretsPushed.clear();
  const swept = await run(baseRecipe(), `export async function deploy(ctx) { await ctx.step("prepare", "success"); }`);
  say(
    "a required host secret is pushed by the host",
    swept.ok && secretsPushed.get("CF_API_TOKEN") === API_TOKEN,
    String(secretsPushed.has("CF_API_TOKEN")),
  );

  // 11a. An adopted resource is bound by its own id, and no create call goes out
  // for it — the options page already settled which one this deployment writes
  // into.
  const beforeAdopt = requests.length;
  const adopted = await run(
    baseRecipe(),
    reporting(`
      const { databaseId } = await ctx.d1.provision("db");
      notes.push("db=" + databaseId);
      notes.push("ctxName=" + ctx.ctx.resourceNames.db);
    `),
    { adopted: { db: { name: "legacy-probe-db", id: "d1-uuid-legacy" } } },
  );
  const createCalls = requests
    .slice(beforeAdopt)
    .filter((entry) => entry.startsWith("POST") && entry.includes("/d1/database"));
  say(
    "an adopted resource is used as-is, with nothing created",
    adopted.ok && adopted.notes.join(" ").includes("db=d1-uuid-legacy") && createCalls.length === 0,
    `${adopted.notes.join(" ")} | ${createCalls.length} create call(s)`,
  );
  // The name the script is told it got has to be the one the Worker is bound to,
  // or a var built from ${resource:db} addresses a database nobody deployed.
  say(
    "the adopted resource's own name is what the script is told",
    adopted.notes.join(" ").includes("ctxName=legacy-probe-db"),
    adopted.notes.join(" "),
  );

  // 11b. The frame runs the package and nothing else. Every route from bytes the
  // recipe can obtain to code this frame would execute, tried in turn.
  const escapes = await run(
    baseRecipe(),
    reporting(`
      try { URL.createObjectURL(new Blob(["x"])); notes.push("blob=MINTED"); } catch (e) { notes.push("blob=blocked"); }
      try { (0, eval)("1"); notes.push("eval=RAN"); } catch (e) { notes.push("eval=blocked"); }
      try { new Function("return 1")(); notes.push("function=RAN"); } catch (e) { notes.push("function=blocked"); }
      try { await import("https://esm.sh/nanoid@5"); notes.push("remote=IMPORTED"); } catch (e) { notes.push("remote=blocked"); }
      try {
        const element = document.createElement("script");
        element.textContent = "window.__injected = true;";
        document.head.appendChild(element);
        notes.push(window.__injected ? "inline=RAN" : "inline=blocked");
      } catch (e) { notes.push("inline=blocked"); }
    `),
  );
  const attempted = escapes.notes.join(" ");
  say(
    "a recipe cannot run code that did not arrive in its package",
    escapes.ok && !/MINTED|RAN|IMPORTED/.test(attempted),
    attempted,
  );

  // 12. The two timers, exercised by shrinking the budgets the shipping code
  // reads rather than by waiting out the real ones.
  const limits = BRIDGE_LIMITS as unknown as { runTimeoutMs: number; callTimeoutMs: number };
  const realRunTimeout = limits.runTimeoutMs;
  limits.runTimeoutMs = 700;
  const hung = await run(quiet, `export async function deploy() { await new Promise(() => {}); }`);
  limits.runTimeoutMs = realRunTimeout;
  say("the run budget stops a hung recipe", !hung.ok && /time budget/.test(hung.message), hung.message);
  say("a killed run leaves no frame behind", document.querySelectorAll("iframe").length === 0, `${document.querySelectorAll("iframe").length} left`);

  const realCallTimeout = limits.callTimeoutMs;
  limits.callTimeoutMs = 400;
  hangProbe = true;
  const stuck = await run(quiet, `export async function deploy(ctx) { await ctx.probe.reachable("https://app.example.com/version"); }`);
  hangProbe = false;
  limits.callTimeoutMs = realCallTimeout;
  say("a stuck capability call times out", !stuck.ok && /timed out/.test(stuck.message), stuck.message);

  say("no request ever carried a credential in its URL", !requests.some((entry) => entry.includes(API_TOKEN) || entry.includes(ASSET_JWT)), `${requests.length} requests`);

  out.textContent += `\n${failures === 0 ? "all probes passed" : `${failures} probe(s) failed`}\n`;
  document.title = failures === 0 ? "engine: ok" : `engine: ${failures} failed`;
}

void main();
