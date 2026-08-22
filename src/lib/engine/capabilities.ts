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

// Where a permitted capability call turns into real work. The sandbox host has
// already checked that the method exists and that recipe.json declared its
// capability; what is checked here is the other half of the boundary — *what* a
// call may touch:
//
//   - a resource id must be one recipe.json declared, of the matching kind, and
//     already provisioned before it can be queried
//   - bindings are built from the recipe, so a script cannot bind storage the
//     user never saw, nor redefine a var the recipe fixed
//   - an asset upload session comes back as an opaque handle; its JWT stays here
//   - a host secret is named by the script and read from the host's own
//     credentials, and the reply carries no value back
//   - every failure message is scrubbed before the sandbox can read it

import type { DeployCredentials, DeployTarget, ResultCredential, StepStatus } from "../deploy/types";
import { RECIPE_LIMITS, type HostSecretSource, type Recipe, type RecipeResource, type ResourceKind } from "../recipe/types";
import { BRIDGE_LIMITS } from "../sandbox/protocol";

import { uploadAssets, type AssetManifest } from "../deploy/assets";
import { buildBindings, interpolate } from "../deploy/bindings";
import { setCron } from "../deploy/cron";
import { createDatabase, runQuery } from "../deploy/d1";
import { attachCustomDomain, listCustomDomains } from "../deploy/domains";
import { probeReachable } from "../deploy/health";
import { createNamespace } from "../deploy/kv";
import { effectiveResourceNames } from "../deploy/match";
import { createBucket } from "../deploy/r2";
import { pushSecret } from "../deploy/secrets";
import { deleteScript, readCrons, switchTraffic, uploadWorkerVersion } from "../deploy/workerVersion";

const MAX_PATH_CHARS = 512;
const MAX_SECRET_CHARS = 64 * 1024;
const MAX_VAR_CHARS = 4096;
const MAX_QUERY_PARAMS = 200;
const MAX_CRONS = 10;
const MAX_RESULT_CREDENTIALS = 20;
const MAX_RESULT_NOTES = 50;

const STEP_STATUSES = new Set<StepStatus>(["running", "success", "skipped", "failed"]);
const CRON_RE = /^[0-9A-Za-z*/,\-? ]{1,120}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const VERSION_ID_RE = /^[0-9a-f-]{8,64}$/i;

/** Ambiguous glyphs left out: these get read off a screen and typed back in. */
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

interface Provisioned {
  kind: ResourceKind;
  name: string;
  /** D1 database id, KV namespace id, or the bucket name for R2. */
  id: string;
}

export interface ResultPatch {
  url: string;
  credentials: ResultCredential[];
  notes: string[];
}

/** The recipe plus the unpacked data package bytes it runs against. */
export interface RecipePackage {
  recipe: Recipe;
  files: Map<string, Uint8Array>;
  tag: string;
}

export interface CapabilityInput {
  pkg: RecipePackage;
  creds: DeployCredentials;
  target: DeployTarget;
  /** What `${uuid}` expands to — one value for the whole deployment. */
  deploymentUuid: string;
  onStep: (id: string, status: StepStatus, detail?: string) => void;
  onProgress: (id: string, fraction: number) => void;
}

export interface CapabilityHost {
  /** Runs one call the sandbox host already permitted. */
  invoke(method: string, args: unknown[], signal?: AbortSignal): Promise<unknown>;
  /** What the recipe reported for the done page, merged across calls. */
  result(): ResultPatch;
  /** Host secrets the recipe pushed itself. */
  pushedHostSecrets(): Set<string>;
  /** Pushes one declared host secret, for the ones a recipe left out. */
  pushHostSecret(name: string): Promise<void>;
  /** Step last set running, so a host-side failure lands on the right line. */
  currentStep(): string;
  /** The Worker version whose traffic this recipe switched, if any. */
  activeVersionId(): string | undefined;
}

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > limit) throw new Error(`${label} is longer than ${limit} characters`);
  return value;
}

function fraction(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, number));
}

function bounded(value: unknown, fallback: number, low: number, high: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expected a number");
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > limit) throw new Error(`${label} may hold at most ${limit} entries`);
  return value;
}

/** Package-relative, no escaping, no Windows separators — the recipe validator's bar. */
function packagePath(value: unknown): string {
  const path = text(value, "the package path", MAX_PATH_CHARS).trim();
  if (!path) throw new Error("the package path is empty");
  if (path.startsWith("/") || path.includes("\\") || path.includes("//")) throw new Error(`not a package-relative path: ${path}`);
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`not a package-relative path: ${path}`);
  }
  return path;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function generatePassword(length: number): string {
  const values = crypto.getRandomValues(new Uint32Array(length));
  let out = "";
  for (const value of values) out += PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length];
  return out;
}

function randomBase64(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createCapabilityHost(input: CapabilityInput): CapabilityHost {
  const { pkg, creds, target } = input;
  const recipe: Recipe = pkg.recipe;
  const accountId = creds.accountId;
  const script = target.workerName;
  // A rebuild deleted the live script, so the upload declares the full binding
  // set as if the Worker were new rather than inheriting one.
  const mode = target.fullRebuild ? "fresh" : target.mode;

  const provisioned = new Map<string, Provisioned>();
  const assetSessions = new Map<string, string>();
  const uploadedVersions = new Set<string>();
  let activeVersion: string | undefined;
  const pushed = new Set<string>();
  const collected: ResultPatch = { url: "", credentials: [], notes: [] };
  let step = "";
  let assetHandles = 0;

  // Keyed by the token's own text, the way ../deploy/bindings.ts reads it.
  const tokens: Record<string, string> = {
    worker: script,
    version: recipe.version,
    buildTime: recipe.buildTime,
    tag: pkg.tag,
    uuid: input.deploymentUuid,
    accountId,
  };
  for (const [id, name] of Object.entries(effectiveResourceNames(target))) tokens[`resource:${id}`] = name;
  for (const [id, value] of Object.entries(target.inputs)) tokens[`input:${id}`] = String(value);

  // Anything that identifies the deploying account or authorises a call on its
  // behalf. Cloudflare echoes request context into its error text, and that
  // text would otherwise reach the sandbox verbatim. The session credential
  // itself is never in this list — it is an HttpOnly cookie this frame cannot
  // read, so it cannot leak into an error message either.
  const scrub = (message: string): string => {
    let out = message;
    const secrets = [creds.cfApiToken, creds.r2SecretAccessKey, creds.r2AccessKeyId, accountId, ...assetSessions.values()];
    for (const secret of secrets) {
      if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[redacted]");
    }
    out = out.replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
    const origin = typeof location === "undefined" ? "" : location.origin;
    if (origin) out = out.split(origin).join("");
    return clip(out, BRIDGE_LIMITS.maxErrorChars);
  };

  const stepOf = (value: unknown): string => {
    const id = text(value, "the step id", 64);
    if (!recipe.steps.some((entry) => entry.id === id)) throw new Error(`recipe.json declares no step "${clip(id, 60)}"`);
    return id;
  };

  const fileBytes = (value: unknown): Uint8Array => {
    const path = packagePath(value);
    const bytes = pkg.files.get(path);
    if (!bytes) throw new Error(`the package has no file at ${path}`);
    return bytes;
  };

  const fileText = (value: unknown): string => new TextDecoder().decode(fileBytes(value));

  const resourceOf = (value: unknown, kind: ResourceKind): RecipeResource => {
    const id = text(value, "the resource id", 64);
    const resource = recipe.resources.find((entry) => entry.id === id);
    if (!resource) throw new Error(`recipe.json declares no resource "${clip(id, 60)}"`);
    if (resource.kind !== kind) throw new Error(`resource "${resource.id}" is ${resource.kind}, not ${kind}`);
    return resource;
  };

  /**
   * Adopting an existing resource is the host's decision, taken on the options
   * page against one reading of the account and shown to the user there. By the
   * time a recipe asks, the answer is already settled — it names a resource id
   * and gets back whatever that id resolved to, with no say in which.
   */
  const provision = async (resource: RecipeResource, create: (name: string) => Promise<string>): Promise<Provisioned> => {
    const existing = provisioned.get(resource.id);
    if (existing) return existing;
    const adopted = target.adopted[resource.id];
    const name = adopted ? adopted.name : target.resourceNames[resource.id] || "";
    if (!RECIPE_LIMITS.namePattern.test(name)) throw new Error(`resource "${resource.id}" has no usable name for this deployment`);
    const entry: Provisioned = { kind: resource.kind, name, id: adopted ? adopted.id : await create(name) };
    provisioned.set(resource.id, entry);
    return entry;
  };

  const hostSecretValue = (source: HostSecretSource): string => {
    switch (source) {
      case "accountId":
        return accountId;
      case "r2AccessKeyId":
        return creds.r2AccessKeyId;
      case "r2SecretAccessKey":
        return creds.r2SecretAccessKey;
      case "cfApiToken":
        return creds.cfApiToken;
    }
  };

  /**
   * The value is read here and handed straight to Cloudflare — it never appears
   * in a reply, a note or a log line.
   */
  const putHostSecret = async (value: unknown, signal?: AbortSignal): Promise<void> => {
    const name = text(value, "the secret name", 64);
    const declared = (recipe.hostSecrets || []).find((entry) => entry.name === name);
    if (!declared) throw new Error(`recipe.json declares no host secret named "${clip(name, 60)}"`);
    const secret = hostSecretValue(declared.source);
    if (!secret) {
      if (declared.requirement === "required") throw new Error(`this deployment has no value for the required secret ${name}`);
      return;
    }
    await pushSecret(accountId, script, name, secret, signal);
    pushed.add(name);
  };

  const extraVarsOf = (value: unknown): Record<string, string> => {
    const raw = record(value, "extraVars");
    const declared = new Set((recipe.worker.vars || []).map((entry) => entry.name));
    const out: Record<string, string> = {};
    const entries = Object.entries(raw);
    if (entries.length > RECIPE_LIMITS.maxVars) throw new Error(`extraVars may hold at most ${RECIPE_LIMITS.maxVars} entries`);
    for (const [name, item] of entries) {
      if (!RECIPE_LIMITS.bindingPattern.test(name)) throw new Error(`"${clip(name, 60)}" is not a usable var name`);
      // The vars recipe.json declares are the ones the review page showed the
      // user; a script may add to them but not redefine them.
      if (declared.has(name)) throw new Error(`recipe.json already declares the var ${name}`);
      out[name] = text(item, `the value of ${name}`, MAX_VAR_CHARS);
    }
    return out;
  };

  const uploadVersion = async (value: unknown, signal?: AbortSignal): Promise<{ versionId: string }> => {
    const options = record(value, "the upload options");
    let assetJwt: string | undefined;
    if (options.assets !== undefined && options.assets !== null) {
      const handle = text(options.assets, "the asset handle", 64);
      const jwt = assetSessions.get(handle);
      if (!jwt) throw new Error("that asset upload handle is not one this deployment created");
      assetJwt = jwt;
    }

    const vars: Record<string, string> = {};
    for (const entry of recipe.worker.vars || []) vars[entry.name] = interpolate(entry.value, tokens);
    for (const [name, item] of Object.entries(extraVarsOf(options.extraVars))) vars[name] = item;

    const resourceIds: Record<string, string> = {};
    const resourceNames: Record<string, string> = {};
    for (const [id, entry] of provisioned) {
      resourceIds[id] = entry.id;
      resourceNames[id] = entry.name;
    }

    const versionId = await uploadWorkerVersion(
      {
        accountId,
        script,
        workerModule: recipe.worker.module,
        workerBytes: fileBytes(recipe.worker.module),
        bindings: buildBindings({ recipe, mode, resourceIds, resourceNames, vars, declareContainers: target.declareContainers }),
        containers: target.declareContainers,
        assetJwt,
        assetHeaders: recipe.worker.assetHeaders ? fileText(recipe.worker.assetHeaders) : undefined,
        compatibilityDate: recipe.worker.compatibilityDate,
        compatibilityFlags: recipe.worker.compatibilityFlags,
        mode,
      },
      signal,
    );
    uploadedVersions.add(versionId);
    return { versionId };
  };

  const upload = async (signal?: AbortSignal): Promise<string> => {
    const manifestPath = recipe.worker.assetsManifest;
    if (!manifestPath) throw new Error("recipe.json declares no assets manifest");
    const parsed: unknown = JSON.parse(fileText(manifestPath));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the assets manifest is not an object");
    const jwt = await uploadAssets({
      accountId,
      script,
      files: pkg.files,
      manifest: parsed as AssetManifest,
      assetsDir: recipe.worker.assetsDir || "assets",
      onProgress: (loaded, total) => {
        if (step) input.onProgress(step, total ? loaded / total : 1);
      },
      signal,
    });
    // The session JWT authorises writes to the account's asset store, so the
    // recipe is given a name for it rather than the thing itself.
    const handle = `assets-${++assetHandles}`;
    assetSessions.set(handle, jwt);
    return handle;
  };

  const queryParams = (value: unknown): unknown[] | undefined => {
    if (value === undefined || value === null) return undefined;
    const params = list(value, "the query parameters", MAX_QUERY_PARAMS);
    for (const param of params) {
      const kind = typeof param;
      if (param !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
        throw new Error("query parameters must be strings, numbers, booleans or null");
      }
    }
    return params;
  };

  const probeTarget = (value: unknown): string => {
    const raw = text(value, "the probe URL", 2048);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("the probe URL is not a URL");
    }
    if (url.protocol !== "https:") throw new Error("only https URLs can be probed");
    const host = url.hostname.toLowerCase();
    // A probe reports reachability and nothing else, but it is still a request
    // from the user's browser — keep it off their own machine and network.
    if (host === "localhost" || host.endsWith(".localhost") || host.includes("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      throw new Error("only public hostnames can be probed");
    }
    return url.toString();
  };

  const mergeResult = (value: unknown): void => {
    const patch = record(value, "the result patch");
    if (patch.url !== undefined) {
      const url = text(patch.url, "the result URL", 2048);
      if (!/^https:\/\//i.test(url)) throw new Error("the result URL must be https");
      collected.url = url;
    }
    if (patch.credentials !== undefined) {
      for (const entry of list(patch.credentials, "the result credentials", MAX_RESULT_CREDENTIALS)) {
        const row = record(entry, "a result credential");
        collected.credentials.push({
          label: clip(text(row.label, "a credential label", 200), 120),
          value: text(row.value, "a credential value", MAX_VAR_CHARS),
          secret: row.secret === true,
        });
      }
      if (collected.credentials.length > MAX_RESULT_CREDENTIALS) collected.credentials.length = MAX_RESULT_CREDENTIALS;
    }
    if (patch.notes !== undefined) {
      for (const note of list(patch.notes, "the result notes", MAX_RESULT_NOTES)) {
        collected.notes.push(clip(text(note, "a result note", 2000), 500));
      }
      if (collected.notes.length > MAX_RESULT_NOTES) collected.notes.length = MAX_RESULT_NOTES;
    }
  };

  const dispatch = async (method: string, args: unknown[], signal?: AbortSignal): Promise<unknown> => {
    switch (method) {
      case "step.set": {
        const id = stepOf(args[0]);
        const status = text(args[1], "the step status", 32) as StepStatus;
        if (!STEP_STATUSES.has(status)) throw new Error(`"${clip(status, 40)}" is not a step status`);
        if (status === "running") step = id;
        input.onStep(id, status, args[2] === undefined ? undefined : clip(text(args[2], "the step detail", 4000), BRIDGE_LIMITS.maxErrorChars));
        return undefined;
      }
      case "step.progress":
        input.onProgress(stepOf(args[0]), fraction(args[1]));
        return undefined;
      case "result.set":
        mergeResult(args[0]);
        return undefined;

      case "pkg.file":
        // A copy, so the package's own bytes cannot be mutated through it.
        return fileBytes(args[0]).slice();
      case "pkg.text":
        return fileText(args[0]);

      case "crypto.sha256Hex": {
        const value = args[0];
        const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(text(value, "the value to hash", 4 * 1024 * 1024));
        return sha256Hex(bytes);
      }
      case "crypto.password":
        return generatePassword(bounded(args[0], 12, 8, 128));
      case "crypto.randomBase64":
        return randomBase64(bounded(args[0], 48, 8, 1024));
      case "crypto.uuid":
        return crypto.randomUUID();

      case "d1.provision": {
        const entry = await provision(resourceOf(args[0], "d1"), (name) => createDatabase(accountId, name, signal));
        return { databaseId: entry.id };
      }
      case "d1.query": {
        const resource = resourceOf(args[0], "d1");
        const entry = provisioned.get(resource.id);
        // Querying a database this run never provisioned would mean naming one
        // by id, which is what the resource list exists to prevent.
        if (!entry) throw new Error(`resource "${resource.id}" has not been provisioned yet`);
        const sql = text(args[1], "the SQL", BRIDGE_LIMITS.maxSqlChars);
        return runQuery(accountId, entry.id, sql, queryParams(args[2]), signal);
      }
      case "r2.provision": {
        const entry = await provision(resourceOf(args[0], "r2"), async (name) => {
          await createBucket(accountId, name, signal);
          return name;
        });
        return { bucketName: entry.name };
      }
      case "kv.provision": {
        const entry = await provision(resourceOf(args[0], "kv"), (name) => createNamespace(accountId, name, signal));
        return { namespaceId: entry.id };
      }

      case "secrets.put": {
        const name = text(args[0], "the secret name", 64);
        if (!RECIPE_LIMITS.bindingPattern.test(name)) throw new Error(`"${clip(name, 60)}" is not a usable secret name`);
        await pushSecret(accountId, script, name, text(args[1], "the secret value", MAX_SECRET_CHARS), signal);
        return undefined;
      }
      case "secrets.putHostValue":
        await putHostSecret(args[0], signal);
        return undefined;

      case "worker.deleteScript":
        // Deleting the script drops its secrets, schedules and domains with it,
        // so it happens only when the user asked for a rebuild.
        if (!target.fullRebuild) throw new Error("deleting the Worker needs the full-rebuild option, which this deployment did not choose");
        await deleteScript(accountId, script, signal);
        return undefined;
      case "worker.uploadVersion":
        return uploadVersion(args[0], signal);
      case "worker.switchTraffic": {
        const versionId = text(args[0], "the version id", 64);
        if (!VERSION_ID_RE.test(versionId) || !uploadedVersions.has(versionId)) {
          throw new Error("traffic can only be switched to a version this deployment uploaded");
        }
        await switchTraffic(accountId, script, versionId, signal);
        activeVersion = versionId;
        return undefined;
      }
      case "assets.upload":
        return upload(signal);

      case "cron.read":
        return readCrons(accountId, script, signal);
      case "cron.set": {
        const crons = list(args[0], "the schedules", MAX_CRONS).map((entry) => text(entry, "a schedule", 120));
        for (const cron of crons) if (!CRON_RE.test(cron)) throw new Error(`"${clip(cron, 60)}" is not a cron expression`);
        await setCron(accountId, script, crons, signal);
        return undefined;
      }

      case "domains.list":
        // Hostnames only: the zone ids that come with them are host bookkeeping.
        return (await listCustomDomains(accountId, script, signal)).map((domain) => domain.hostname);
      case "domains.attach": {
        const hostname = text(args[0], "the hostname", 253).trim().toLowerCase();
        if (!HOSTNAME_RE.test(hostname)) throw new Error(`"${clip(hostname, 80)}" is not a hostname`);
        await attachCustomDomain(accountId, script, hostname, undefined, undefined, signal);
        return undefined;
      }

      case "probe.reachable":
        return probeReachable(probeTarget(args[0]), undefined, undefined, signal);

      default:
        throw new Error(`unknown capability method: ${clip(method, 60)}`);
    }
  };

  // Nothing leaves this module with an unscrubbed message, whether the sandbox
  // asked or the engine did.
  const scrubbed = async <T,>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new Error(scrub(error instanceof Error ? error.message : String(error)));
    }
  };

  return {
    invoke: (method, args, signal) => scrubbed(() => dispatch(method, args, signal)),
    result: () => collected,
    pushedHostSecrets: () => pushed,
    pushHostSecret: (name) => scrubbed(() => putHostSecret(name)),
    currentStep: () => step,
    activeVersionId: () => activeVersion,
  };
}
