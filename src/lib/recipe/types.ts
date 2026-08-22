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

export const RECIPE_SCHEMA = 2;

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
 * One row of the authority table: something this package needs to be allowed to
 * do, in words, next to the Cloudflare OAuth scopes that grant it.
 *
 * The wizard asks Cloudflare for the union of every row's `oauthScopes`, so
 * these are what the consent screen will list. A row may name no scope at all —
 * the R2 S3 key pair is the one authority Cloudflare's OAuth namespace does not
 * cover — and such a row is collected by hand instead.
 */
export interface RecipePermission {
  key: string;
  requirement: Requirement;
  /**
   * Cloudflare OAuth scopes, in Cloudflare's own dotted namespace. Every one
   * must be in shared/oauthScopes.ts: a scope this deployment's OAuth client was
   * never registered to hold cannot be granted, and asking for it fails at
   * Cloudflare where the user can do nothing about it.
   */
  oauthScopes: string[];
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
  /**
   * A Cloudflare dashboard link that turns the checked feature on (e.g. the R2
   * page when R2 is not enabled). Restricted to `dash.cloudflare.com` so a
   * recipe cannot point it elsewhere. When present, a check that is not "ok"
   * reads as "not enabled" with this as the fix, rather than a hard failure.
   */
  actionUrl?: string;
}

export type ResourceKind = "d1" | "r2" | "kv";

/**
 * How to recognise a resource in the account that already belongs to this app —
 * the database a two-versions-ago release created under a name nothing computes
 * any more, the bucket someone renamed by hand.
 *
 * Without it the wizard only ever looks for the one name it would create, so an
 * upgrade quietly deploys against an empty resource and leaves the real one
 * bound to nothing. With it, the host lists what the account holds and works
 * down this declaration: every exact name first, in the order given, and only
 * then the patterns. A pattern that matches more than one existing resource
 * adopts none of them — the choice goes to the user instead.
 */
export interface RecipeResourceMatch {
  /** Exact names. Interpolated, then compared literally. */
  names?: Interpolated[];
  /** Regular-expression sources. The host anchors each one whole. */
  patterns?: string[];
}

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
  /** How to find an instance of this resource the account already holds. */
  match?: RecipeResourceMatch;
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
  /** A declared Docker Hub image reference, resolved by the trusted host only. */
  image?: RecipeContainerImage;
}

export interface RecipeContainerImage {
  /** Immutable Docker Hub digest the review page can state exactly. */
  reference: string;
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
  /** Render only while another input has this exact scalar value. `mode` limits when the predicate applies. */
  visibleWhen?: { input: string; equals: string | boolean; mode?: DeployMode };
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

// No "apiToken": the session credential is a cookie the recipe's Worker could
// never read back even if the host offered it, so a recipe cannot declare a
// host secret sourced from it — only the account id and the R2 S3 key pair,
// which stay in the host regardless of the OAuth session, may be handed over.
/**
 * Where a host-provided Workers Secret's value comes from. `apiToken` (the
 * deploying session credential) is deliberately absent and must stay so — a
 * recipe that could name it would exfiltrate the session token. `cfApiToken` is
 * a different object: a narrow token minted or pasted *for the app*, never the
 * session credential.
 */
export type HostSecretSource = "accountId" | "r2AccessKeyId" | "r2SecretAccessKey" | "cfApiToken";

/**
 * How the deployment authenticates to Cloudflare. Mutually exclusive per run:
 * whichever mode is chosen provides all the account authority the deployment
 * uses. `oauth` cannot furnish an app a long-lived credential, so a recipe that
 * needs one (a `cfApiToken` host secret) must offer `auto`.
 */
export type AuthMode = "oauth" | "auto";

/**
 * One permission the app's own token must carry, in Cloudflare's token-template
 * form: a `key` from shared/cfTokenPermissions.ts and a `type`. These are what
 * the "create a token" deep link pre-fills, so the user builds exactly the
 * token the app needs. A key outside the table is rejected at load time.
 */
export interface CfTokenPermissionRequest {
  key: string;
  type: "read" | "edit";
  /** How much this permission matters. Defaults to "required" when omitted; an
   *  "optional" one is offered as a checkbox the user can leave out of the
   *  pre-filled token link. */
  requirement?: Requirement;
  /** What the app uses this permission for, shown next to it on the token step. */
  scenario?: Localized;
}

/**
 * A Workers Secret whose *value* comes from the host, not the recipe — the way
 * an app receives a credential without the recipe script ever reading it.
 * Declared here so the review page can state plainly what the app will hold.
 */
export interface RecipeHostSecret {
  name: string;
  source: HostSecretSource;
  reason: Localized;
  requirement: Requirement;
  /**
   * Only for `source: "cfApiToken"` — the permissions the app's own long-lived
   * token must carry, in template `{ key, type }` form. In auto mode the user
   * creates a token against exactly these (a deep link pre-fills them) and
   * pastes it. Absent for every other source.
   */
  permissions?: CfTokenPermissionRequest[];
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
  /** Which authentication modes this package supports; the wizard offers these. */
  authModes: AuthMode[];
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
  /** Per resource, for the match declaration. */
  maxMatchNames: 12,
  maxMatchPatterns: 8,
  maxPatternChars: 200,
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
