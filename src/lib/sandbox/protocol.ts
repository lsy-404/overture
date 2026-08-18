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

// The wire between the host page and a package's `recipe.js`.
//
// The script runs in an <iframe sandbox="allow-scripts"> — an opaque origin, so
// it shares no DOM, storage or global with the host and cannot read the
// Cloudflare API token or the R2 key pair. Every effect it wants is a message
// on this channel, which the host answers only after checking the recipe
// declared the matching capability. That check is the whole security boundary:
// a capability the recipe did not declare does not exist for it.
//
// Credentials never appear in any message defined here. When an app needs the
// deploying account's own token, the recipe declares a host secret and calls
// `secrets.putHostValue` — the host reads the value from its own state and
// pushes it, so the script names a credential it can never see.
//
// There is deliberately no logging channel. This is a public deployer running
// against strangers' Cloudflare accounts, so nothing narrates what a deployment
// did — the only diagnostic a recipe can produce is a failure attached to the
// step it happened in, which is what the user needs to recover and nothing more.

import type { Capability, Recipe } from "../recipe/types";
import type { DeployMode, LiveScriptFacts, ResultCredential } from "../deploy/types";

/** Bumped only on a breaking change to the messages below. */
export const BRIDGE_PROTOCOL = 1;

/**
 * Everything the script gets to know. Note what is missing: account id, API
 * token, R2 keys, and any input the wizard marked as host-only.
 */
export interface GuestContext {
  protocol: typeof BRIDGE_PROTOCOL;
  recipe: Recipe;
  mode: DeployMode;
  workerName: string;
  /** Resource id → provisioned name. Ids are the recipe's own. */
  resourceNames: Record<string, string>;
  /** Input id → value. */
  inputs: Record<string, string | boolean>;
  live: LiveScriptFacts;
  /** Container class names the host will declare on the new version. */
  declareContainers: string[];
  fullRebuild: boolean;
  domain: string;
  tag: string;
  version: string;
  buildTime: string;
  locale: string;
}

// ---------------------------------------------------------------------------
// Capability methods
// ---------------------------------------------------------------------------

/**
 * `null` marks a method with no capability gate: it either only talks to the
 * UI, or reads bytes the script already received in its own package.
 */
export const METHOD_GATES: Record<string, Capability | null> = {
  "step.set": null,
  "step.progress": null,
  "result.set": null,
  "pkg.file": null,
  "pkg.text": null,
  "crypto.sha256Hex": null,
  "crypto.password": null,
  "crypto.randomBase64": null,
  "crypto.uuid": null,

  "d1.provision": "d1",
  "d1.query": "d1",
  "r2.provision": "r2",
  "kv.provision": "kv",
  "secrets.put": "secrets",
  "secrets.putHostValue": "secrets",
  "worker.deleteScript": "worker",
  "worker.uploadVersion": "worker",
  "worker.switchTraffic": "worker",
  "assets.upload": "assets",
  "cron.read": "cron",
  "cron.set": "cron",
  "domains.list": "domains",
  "domains.attach": "domains",
  "probe.reachable": "probe",
};

export type CapabilityMethod = keyof typeof METHOD_GATES;

/**
 * The surface as the script sees it, after the guest bootstrap wraps each
 * method into a promise. Written out as one interface so the host router, the
 * guest wrapper and docs/RECIPE.md cannot drift apart.
 */
export interface RecipeContext {
  readonly ctx: GuestContext;

  /** Move a checklist line declared in recipe.json's `steps`. */
  step(id: string, status: "running" | "success" | "skipped" | "failed", detail?: string): Promise<void>;
  /** 0–1 within the given step. */
  progress(id: string, fraction: number): Promise<void>;
  /** Values the done page shows the user. Merged across calls. */
  result(patch: { url?: string; credentials?: ResultCredential[]; notes?: string[] }): Promise<void>;

  /** Bytes of a package file. Paths are package-relative and may not escape it. */
  file(path: string): Promise<Uint8Array>;
  text(path: string): Promise<string>;

  d1: {
    /** Creates the database if the account has no such name, and returns its id. */
    provision(resourceId: string): Promise<{ databaseId: string }>;
    query(resourceId: string, sql: string, params?: unknown[]): Promise<unknown>;
  };
  r2: {
    provision(resourceId: string): Promise<{ bucketName: string }>;
  };
  kv: {
    provision(resourceId: string): Promise<{ namespaceId: string }>;
  };
  secrets: {
    put(name: string, value: string): Promise<void>;
    /** Pushes a credential the host holds; the script never receives the value. */
    putHostValue(name: string): Promise<void>;
  };
  worker: {
    /** Full rebuild only. Bindings are re-declared on the next uploadVersion. */
    deleteScript(): Promise<void>;
    /**
     * Uploads a new version. The host builds the binding set from the recipe's
     * resources, vars and container choices plus whatever the script provisioned
     * — the script cannot inject a binding the recipe never declared.
     */
    uploadVersion(options?: { assets?: string; extraVars?: Record<string, string> }): Promise<{ versionId: string }>;
    switchTraffic(versionId: string): Promise<void>;
  };
  assets: {
    /** Uploads the package's static assets and returns an opaque session handle. */
    upload(): Promise<string>;
  };
  cron: {
    read(): Promise<string[]>;
    set(crons: string[]): Promise<void>;
  };
  domains: {
    list(): Promise<string[]>;
    attach(hostname: string): Promise<void>;
  };
  probe: {
    /** Best-effort GET; resolves with the outcome instead of throwing. */
    reachable(url: string): Promise<{ ok: boolean; status: number }>;
  };
  crypto: {
    sha256Hex(value: string | Uint8Array): Promise<string>;
    password(length?: number): Promise<string>;
    randomBase64(bytes?: number): Promise<string>;
    uuid(): Promise<string>;
  };
}

/** What a package's `recipe.js` must export. */
export type RecipeDeploy = (ctx: RecipeContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface HostStartMessage {
  kind: "start";
  protocol: typeof BRIDGE_PROTOCOL;
  context: GuestContext;
  /** Source text of the package's recipe.js, inlined rather than fetched. */
  script: string;
}

export interface HostReplyMessage {
  kind: "reply";
  id: number;
  ok: boolean;
  /** Structured-cloneable value on success. */
  value?: unknown;
  /** Failure text, already stripped of anything host-private. */
  message?: string;
}

export type HostMessage = HostStartMessage | HostReplyMessage;

export interface GuestReadyMessage {
  kind: "ready";
  protocol: number;
}

export interface GuestCallMessage {
  kind: "call";
  id: number;
  method: string;
  args: unknown[];
}

export interface GuestFinishedMessage {
  kind: "finished";
}

export interface GuestFailedMessage {
  kind: "failed";
  message: string;
  /** Step id the failure belongs to, when the script was inside one. */
  step?: string;
}

export type GuestMessage = GuestReadyMessage | GuestCallMessage | GuestFinishedMessage | GuestFailedMessage;

/**
 * Budgets. A package is third-party code: without these a recipe could hang the
 * wizard or hammer the Cloudflare API on the user's token.
 */
export const BRIDGE_LIMITS = {
  /** Whole run, from `start` to `finished`. */
  runTimeoutMs: 15 * 60 * 1000,
  /** A single capability call. */
  callTimeoutMs: 2 * 60 * 1000,
  /** Guest must announce itself this fast or the run is abandoned. */
  readyTimeoutMs: 15 * 1000,
  /** Total capability calls per run. */
  maxCalls: 2000,
  /** Cloudflare-touching calls per run — everything with a non-null gate. */
  maxPrivilegedCalls: 500,
  /** Argument payload of one call. */
  maxCallBytes: 4 * 1024 * 1024,
  /** Failure text and step detail, truncated rather than rejected. */
  maxErrorChars: 500,
  maxSqlChars: 2 * 1024 * 1024,
} as const;
