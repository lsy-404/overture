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

import type { DeployMode } from "../recipe/types";

export type { DeployMode };

export type StepStatus = "pending" | "running" | "success" | "skipped" | "failed";

/**
 * The one checklist line Overture owns rather than the recipe: probing the
 * deployed URL afterwards. The `@` prefix cannot collide with a recipe step id,
 * which the validator restricts to lowercase alphanumerics.
 */
export const HOST_STEP_HEALTH = "@health";

export interface StepState {
  /** Matches a RecipeStep id. */
  id: string;
  status: StepStatus;
  detail?: string;
  /** 0–1, only set by steps that report one. */
  progress?: number;
}

/**
 * The account id the OAuth session is scoped to, plus the one credential that
 * still lives in this frame: the R2 S3 key pair, which OAuth's scope namespace
 * cannot issue. The session credential itself never appears here — it is an
 * HttpOnly cookie the relay reads on the deployer's own Worker, and the R2 pair
 * is optional even so: a recipe declaring `s3Keys` decides whether the deploy
 * can proceed without it.
 */
export interface DeployCredentials {
  accountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  /**
   * The app's own long-lived Cloudflare token, when a recipe declares a
   * `cfApiToken` host secret: the token the user pasted on the authorize step
   * in auto mode. It is the app's credential, never the deploy session's —
   * empty until auto mode supplies it.
   */
  cfApiToken: string;
}

/**
 * What the live script looks like before this deployment touches it, read once
 * up front because a version upload clears schedules and a rebuild deletes the
 * script outright.
 */
export interface LiveScriptFacts {
  exists: boolean;
  /** plain_text bindings of the live version, so a recipe can carry an identity forward. */
  vars: Record<string, string>;
  crons: string[];
  customDomains: string[];
  /** Container class names the live script declares. */
  containerClasses: string[];
}

/** One storage resource the account already holds. */
export interface ExistingResource {
  name: string;
  /** D1 database id, KV namespace id, or the bucket name for R2. */
  id: string;
}

export interface DeployTarget {
  mode: DeployMode;
  workerName: string;
  /** Recipe resource id → the name the user settled on. */
  resourceNames: Record<string, string>;
  /**
   * Recipe resource id → an existing resource this deployment will write into
   * rather than create. Decided on the options page, from the account inventory
   * and the recipe's match declaration, and confirmed by the user; a recipe
   * still only ever names a resource by its own id.
   */
  adopted: Record<string, ExistingResource>;
  /** Recipe input id → the value the user gave. */
  inputs: Record<string, string | boolean>;
  /** Container class names to declare on the new version. */
  declareContainers: string[];
  /** Delete the script and redeploy from scratch, keeping D1/R2/KV data. */
  fullRebuild: boolean;
  /** Custom domain to attach, empty when the user supplied none. */
  domain: string;
}

/** A value the deployment produced that the user needs to keep. */
export interface ResultCredential {
  label: string;
  value: string;
  /** Masked until revealed, and never written to storage. */
  secret?: boolean;
}

export interface DeployResult {
  workerName: string;
  version: string;
  url: string;
  credentials: ResultCredential[];
  notes: string[];
}

export class DeployError extends Error {
  constructor(
    public readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "DeployError";
  }
}
