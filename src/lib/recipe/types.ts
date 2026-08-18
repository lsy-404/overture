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

// The shape of `overture.json`, the install configuration — the small release
// asset that turns a repository into something this wizard can deploy.
// Everything the UI needs in order to ask the user anything lives here,
// including the licence and terms text, so the wizard never has to pull the
// multi-megabyte data package just to show a permission table. The work itself
// lives in the data package's `recipe.js`.
//
// docs/RECIPE.md is the human-facing version of this file. Keep them in step.

export const RECIPE_SCHEMA = 1;

/** Plain string, or per-locale strings keyed by BCP-47 tag with `*` as fallback. */
export type Localized = string | Record<string, string>;

export type Requirement = "required" | "recommended" | "optional";

export type DeployMode = "fresh" | "overwrite";

/**
 * Values a recipe may interpolate into names, vars, URLs and done-page links.
 * The host substitutes them; a recipe never sees the credentials behind
 * `accountId`.
 *
 * | Token             | Expands to                                    |
 * |-------------------|-----------------------------------------------|
 * | `${worker}`       | the Worker name the user chose                |
 * | `${version}`      | package version from the manifest             |
 * | `${buildTime}`    | package build timestamp                       |
 * | `${tag}`          | release tag the package came from             |
 * | `${uuid}`         | a fresh UUID, stable for one deployment       |
 * | `${accountId}`    | the Cloudflare account id                     |
 * | `${url}`          | the deployed URL (done-page links only)       |
 * | `${resource:id}`  | the chosen name of the resource with that id  |
 * | `${input:id}`     | the value the user gave for that input         |
 */
export type Interpolated = string;

/** The data package this configuration installs. */
export interface PackageRef {
  /** Must be the fixed artifact name; a configuration cannot point elsewhere. */
  artifact: string;
  /** Lowercase hex SHA-256 of the artifact bytes. */
  sha256: string;
  bytes?: number;
}

export interface RecipeLicense {
  /** SPDX identifier, shown beside the text. */
  id: string;
  /** The full licence text, inline. Displayed verbatim, never rendered as markup. */
  text: string;
}

export interface RecipeTerms {
  /** Locale tag → the terms text, inline. `*` is the fallback. */
  texts: Record<string, string>;
  /** When true the user must tick acceptance before continuing. */
  required: boolean;
}

/**
 * One row of the API Token permission table. `groups` lists the Cloudflare
 * permission-group names that satisfy the row — holding any one is enough,
 * which is how a token created with either the modern or the legacy group name
 * still passes.
 */
export interface RecipePermission {
  key: string;
  requirement: Requirement;
  groups: string[];
  label: Localized;
  scenario: Localized;
  scope: "account" | "zone" | "allBuckets";
  level: "read" | "write" | "readWrite";
}

/**
 * A read-only probe run before anything is provisioned, to tell the user their
 * account is actually set up for what the recipe needs (R2 enabled, Images
 * subscribed, …). GET only, and the path must be allow-listed by the relay —
 * an unlisted path fails the check rather than reaching Cloudflare.
 */
export interface RecipeCheck {
  id: string;
  requirement: Requirement;
  label: Localized;
  /** CF API path, `${accountId}` interpolated. */
  path: Interpolated;
  hint?: Localized;
}

export type ResourceKind = "d1" | "r2" | "kv";

/**
 * A storage resource the deployment needs. The host renders a name field per
 * entry (pre-filled from `defaultName`), warns when the name already exists in
 * the account, provisions it, and binds it into the Worker as `binding`.
 */
export interface RecipeResource {
  id: string;
  kind: ResourceKind;
  binding: string;
  defaultName: Interpolated;
  required: boolean;
  label: Localized;
  help?: Localized;
  /**
   * r2 only. When set, the wizard collects an R2 S3 key pair and verifies it
   * against the bucket; "required" blocks the deploy without it.
   */
  s3Keys?: Requirement;
}

export interface RecipeVar {
  name: string;
  value: Interpolated;
}

/**
 * A container class the Worker declares. Declaring one the live script never
 * had is rejected by Cloudflare, and omitting one it does have orphans it, so
 * "ask" hands the choice to the user with the live script's own state as the
 * default.
 */
export interface RecipeContainer {
  className: string;
  mode: "ask" | "always" | "never";
  note?: Localized;
}

export interface RecipeWorker {
  defaultName: string;
  /** Package-relative path of the ESM entry module. */
  module: string;
  /** Package-relative path of the Cloudflare assets manifest, if the app ships static assets. */
  assetsManifest?: string;
  /** Package-relative directory holding those assets. Defaults to "assets". */
  assetsDir?: string;
  /** Package-relative `_headers` file passed to Cloudflare verbatim. */
  assetHeaders?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  vars?: RecipeVar[];
  containers?: RecipeContainer[];
  /** Binding name for the static-asset binding. Defaults to "ASSETS". */
  assetsBinding?: string;
}

export type InputKind = "text" | "password" | "toggle" | "domain" | "select";

/** A question the wizard asks the user, rendered on the options page. */
export interface RecipeInput {
  id: string;
  kind: InputKind;
  label: Localized;
  help?: Localized;
  default?: string | boolean;
  required?: boolean;
  /** Anchored regular expression source. Advisory for text, enforced for domain. */
  pattern?: string;
  options?: Array<{ value: string; label: Localized }>;
  /** Render only for this install mode. */
  onlyMode?: DeployMode;
  /** password only — offer a generated value of this many characters. */
  generate?: number;
}

/**
 * What a recipe's script is allowed to reach. The host rejects any capability
 * call whose gate is absent here, so this list is both the permission grant and
 * what the review page shows the user.
 */
export type Capability =
  | "d1"
  | "r2"
  | "kv"
  | "secrets"
  | "worker"
  | "assets"
  | "cron"
  | "domains"
  | "probe";

export type HostSecretSource = "accountId" | "apiToken" | "r2AccessKeyId" | "r2SecretAccessKey";

/**
 * A Workers Secret whose *value* comes from the host, not the recipe — the way
 * an app receives the deploying account's own credentials without the recipe
 * script ever reading them. Declared here so the review page can state plainly
 * that this app will hold the user's Cloudflare API token.
 */
export interface RecipeHostSecret {
  name: string;
  source: HostSecretSource;
  reason: Localized;
  requirement: Requirement;
}

/**
 * One line of the execution checklist. The script drives the transitions; this
 * only declares what the user sees and how much of the aggregate progress bar
 * the line is worth.
 */
export interface RecipeStep {
  id: string;
  label: Localized;
  weight?: number;
  optional?: boolean;
}

export interface RecipeDoneLink {
  label: Localized;
  href: Interpolated;
}

export interface Recipe {
  schema: typeof RECIPE_SCHEMA;
  /** Stable slug. Used for storage keys and nothing user-visible. */
  id: string;
  name: string;
  summary: Localized;
  homepage?: string;
  /** Must agree with the release tag this configuration was published on. */
  version: string;
  tag: string;
  buildTime: string;
  package: PackageRef;
  license: RecipeLicense;
  terms?: RecipeTerms;
  permissions: RecipePermission[];
  checks?: RecipeCheck[];
  resources: RecipeResource[];
  worker: RecipeWorker;
  inputs?: RecipeInput[];
  capabilities: Capability[];
  hostSecrets?: RecipeHostSecret[];
  steps: RecipeStep[];
  /** Package-relative ESM module exporting `deploy(ctx)`. Defaults to "recipe.js". */
  script?: string;
  /** Path appended to the deployed URL for the post-deploy reachability probe. */
  health?: { path: string };
  done?: { links?: RecipeDoneLink[]; notes?: Localized };
}

// Limits the validator enforces. A configuration is data from a third-party
// repository, so every unbounded field is a denial-of-service surface.
export const RECIPE_LIMITS = {
  maxScriptBytes: 512 * 1024,
  maxTermsChars: 200_000,
  maxLicenseChars: 400_000,
  maxPermissions: 40,
  maxChecks: 20,
  maxResources: 12,
  maxInputs: 24,
  maxSteps: 40,
  maxVars: 40,
  maxHostSecrets: 8,
  maxContainers: 4,
  maxDoneLinks: 8,
  /** Resource ids, input ids, step ids, capability keys. */
  idPattern: /^[a-z0-9][a-z0-9_-]{0,39}$/,
  /** Worker/D1/R2/KV names Cloudflare will accept. */
  namePattern: /^[a-z0-9][a-z0-9-]{0,62}$/,
  /** Worker binding names and Workers Secret names. */
  bindingPattern: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
} as const;

export function localized(value: Localized | undefined, locale: string): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return value[locale] || value["*"] || value.en || Object.values(value)[0] || "";
}
