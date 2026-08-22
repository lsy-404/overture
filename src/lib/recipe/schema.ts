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

// The trust boundary. `recipe.json` is JSON from a third-party repository, and
// everything downstream — the permission table, the capability gate, the
// bindings the host declares — reads its fields as facts. So every field is
// checked here, by hand, against the limits in types.ts, and the validated
// object is rebuilt from scratch: fields this file does not know about cannot
// reach the rest of the wizard.
//
// Validation collects every problem rather than stopping at the first, so a
// package author (and a user staring at a rejected package) sees the whole list
// at once.

import { PACKAGE_ARTIFACT_NAME } from "../../../shared/package";
import { isKnownScope } from "../../../shared/oauthScopes";
import { isKnownTokenPermission } from "../../../shared/cfTokenPermissions";
import { METHOD_GATES } from "../sandbox/protocol";
import {
  RECIPE_LIMITS,
  RECIPE_SCHEMA,
  type Capability,
  type DeployMode,
  type AuthMode,
  type CfTokenPermissionRequest,
  type HostSecretSource,
  type InputKind,
  type Localized,
  type PackageRef,
  type Recipe,
  type RecipeCheck,
  type RecipeContainer,
  type RecipeContainerImage,
  type RecipeDoneLink,
  type RecipeHostSecret,
  type RecipeInput,
  type RecipeLicense,
  type RecipePermission,
  type RecipeResource,
  type RecipeResourceMatch,
  type RecipeStep,
  type RecipeTerms,
  type RecipeVar,
  type RecipeWorker,
  type Requirement,
  type ResourceKind,
} from "./types";

const MAX_STRING = 4096;
const MAX_PATH_CHARS = 256;
const MAX_NAME_CHARS = 128;
const MAX_LOCALE_ENTRIES = 30;
const MAX_PERMISSION_SCOPES = 24;
const MAX_TOKEN_PERMISSIONS = 32;
const TOKEN_PERM_TYPES = ["read", "edit"] as const;
const MAX_COMPAT_FLAGS = 20;
const MAX_INPUT_OPTIONS = 40;
const MAX_API_PATH_CHARS = 512;

const LOCALE_KEY_RE = /^(\*|[A-Za-z0-9-]{2,35})$/;
const COMPAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPAT_FLAG_RE = /^[a-z0-9_]{1,64}$/;
const SPDX_RE = /^[A-Za-z0-9-.+ ()]{1,80}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const DOCKER_IMAGE_RE = /^docker\.io\/[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}@sha256:[a-f0-9]{64}$/;

const REQUIREMENTS = ["required", "recommended", "optional"] as const;
const RESOURCE_KINDS = ["d1", "r2", "kv"] as const;
const INPUT_KINDS = ["text", "password", "toggle", "domain", "select"] as const;
const DEPLOY_MODES = ["fresh", "overwrite"] as const;
const PERMISSION_SCOPES = ["account", "zone", "allBuckets"] as const;
const PERMISSION_LEVELS = ["read", "write", "readWrite"] as const;
const CONTAINER_MODES = ["ask", "always", "never"] as const;
const HOST_SECRET_SOURCES = ["accountId", "r2AccessKeyId", "r2SecretAccessKey", "cfApiToken"] as const;
const AUTH_MODES = ["oauth", "auto"] as const;

// Derived from the bridge itself, so a capability the host cannot gate can never
// be declared.
const CAPABILITIES = new Set<string>(
  Object.values(METHOD_GATES).filter((gate): gate is Capability => gate !== null),
);

class Errors {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
}

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bag(errors: Errors, path: string, value: unknown, required: boolean): Bag | undefined {
  if (value === undefined) {
    if (required) errors.add(path, "is required");
    return undefined;
  }
  if (!isBag(value)) {
    errors.add(path, "must be an object");
    return undefined;
  }
  return value;
}

function str(errors: Errors, path: string, value: unknown, required: boolean, max = MAX_STRING): string | undefined {
  if (value === undefined) {
    if (required) errors.add(path, "is required");
    return undefined;
  }
  if (typeof value !== "string") {
    errors.add(path, "must be a string");
    return undefined;
  }
  if (required && !value.trim()) {
    errors.add(path, "must not be empty");
    return undefined;
  }
  if (value.length > max) {
    errors.add(path, `must be at most ${max} characters`);
    return undefined;
  }
  return value;
}

function matching(
  errors: Errors,
  path: string,
  value: unknown,
  pattern: RegExp,
  required: boolean,
): string | undefined {
  const text = str(errors, path, value, required, MAX_NAME_CHARS);
  if (text === undefined) return undefined;
  if (!pattern.test(text)) {
    errors.add(path, `must match ${pattern.source}`);
    return undefined;
  }
  return text;
}

function bool(errors: Errors, path: string, value: unknown, required: boolean): boolean | undefined {
  if (value === undefined) {
    if (required) errors.add(path, "is required");
    return undefined;
  }
  if (typeof value !== "boolean") {
    errors.add(path, "must be a boolean");
    return undefined;
  }
  return value;
}

function integer(
  errors: Errors,
  path: string,
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    errors.add(path, "must be an integer");
    return undefined;
  }
  if (value < min || value > max) {
    errors.add(path, `must be between ${min} and ${max}`);
    return undefined;
  }
  return value;
}

function oneOf<T extends string>(
  errors: Errors,
  path: string,
  value: unknown,
  allowed: readonly T[],
  required: boolean,
): T | undefined {
  if (value === undefined) {
    if (required) errors.add(path, "is required");
    return undefined;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    errors.add(path, `must be one of ${allowed.join(", ")}`);
    return undefined;
  }
  return value as T;
}

function localized(errors: Errors, path: string, value: unknown, required: boolean): Localized | undefined {
  if (value === undefined) {
    if (required) errors.add(path, "is required");
    return undefined;
  }
  if (typeof value === "string") return str(errors, path, value, required);
  if (!isBag(value)) {
    errors.add(path, "must be a string or a locale map");
    return undefined;
  }
  const entries = Object.entries(value);
  if (required && entries.length === 0) {
    errors.add(path, "must have at least one locale");
    return undefined;
  }
  if (entries.length > MAX_LOCALE_ENTRIES) {
    errors.add(path, `must have at most ${MAX_LOCALE_ENTRIES} locales`);
    return undefined;
  }
  const out: Record<string, string> = {};
  let ok = true;
  for (const [locale, text] of entries) {
    if (!LOCALE_KEY_RE.test(locale)) {
      errors.add(`${path}.${locale}`, "is not a locale tag");
      ok = false;
      continue;
    }
    const checked = str(errors, `${path}.${locale}`, text, false);
    if (checked === undefined) {
      ok = false;
      continue;
    }
    out[locale] = checked;
  }
  return ok ? out : undefined;
}

/**
 * Every path a recipe names is read out of the unpacked package, so it has to
 * stay inside it: relative, no `..`, no backslash (which a Windows-built
 * archive could otherwise smuggle a separator through), no empty segments.
 */
function packagePath(errors: Errors, path: string, value: unknown, required: boolean): string | undefined {
  const text = str(errors, path, value, required, MAX_PATH_CHARS);
  if (text === undefined) return undefined;
  const bad =
    !text ||
    text.startsWith("/") ||
    text.includes("\\") ||
    text.includes("\0") ||
    text.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  if (bad) {
    errors.add(path, "must be a relative path inside the package");
    return undefined;
  }
  return text;
}

/** A name with `${…}` tokens still in it must interpolate to something Cloudflare accepts. */
function interpolatedName(errors: Errors, path: string, value: unknown): string | undefined {
  const text = str(errors, path, value, true, MAX_NAME_CHARS);
  if (text === undefined) return undefined;
  const literal = text.replace(/\$\{[^}]{0,64}\}/g, "");
  if (!/^[a-z0-9-]*$/.test(literal)) {
    errors.add(path, "must interpolate to a lowercase name of letters, digits and hyphens");
    return undefined;
  }
  return text;
}

/** A Cloudflare API path for a pre-flight check: relative to the API root, GET-able. */
function apiPath(errors: Errors, path: string, value: unknown): string | undefined {
  const text = str(errors, path, value, true, MAX_API_PATH_CHARS);
  if (text === undefined) return undefined;
  if (!text.startsWith("/") || text.includes("..") || text.includes("\\") || text.includes("://")) {
    errors.add(path, "must be an absolute Cloudflare API path");
    return undefined;
  }
  return text;
}

function httpsUrl(errors: Errors, path: string, value: unknown): string | undefined {
  const text = str(errors, path, value, false, 512);
  if (text === undefined || text === "") return undefined;
  try {
    if (new URL(text).protocol !== "https:") throw new Error("not https");
  } catch {
    errors.add(path, "must be an https URL");
    return undefined;
  }
  return text;
}

function list(errors: Errors, path: string, value: unknown, max: number, required: boolean): unknown[] | undefined {
  if (value === undefined) {
    if (required) errors.add(path, "is required");
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.add(path, "must be an array");
    return undefined;
  }
  if (value.length > max) {
    errors.add(path, `must have at most ${max} entries`);
    return undefined;
  }
  return value;
}

function items<T>(
  errors: Errors,
  path: string,
  value: unknown,
  max: number,
  required: boolean,
  each: (entry: unknown, itemPath: string) => T | undefined,
): T[] | undefined {
  const raw = list(errors, path, value, max, required);
  if (raw === undefined) return undefined;
  const out: T[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = each(raw[index], `${path}[${index}]`);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function stringList(
  errors: Errors,
  path: string,
  value: unknown,
  max: number,
  required: boolean,
  pattern?: RegExp,
): string[] | undefined {
  return items(errors, path, value, max, required, (entry, itemPath) =>
    pattern ? matching(errors, itemPath, entry, pattern, true) : str(errors, itemPath, entry, true, MAX_NAME_CHARS),
  );
}

function requireUnique<T>(errors: Errors, path: string, entries: T[], key: (entry: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = key(entry);
    if (seen.has(value)) errors.add(path, `duplicate ${label} "${value}"`);
    seen.add(value);
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function permission(errors: Errors, path: string, value: unknown): RecipePermission | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const key = matching(errors, `${path}.key`, raw.key, RECIPE_LIMITS.idPattern, true);
  const requirement = oneOf<Requirement>(errors, `${path}.requirement`, raw.requirement, REQUIREMENTS, true);
  // A scope outside this deployment's registered ceiling can never be granted,
  // so a package naming one is rejected here rather than failing at Cloudflare's
  // consent screen, where the user has nothing to act on.
  const oauthScopes = items(errors, `${path}.oauthScopes`, raw.oauthScopes, MAX_PERMISSION_SCOPES, true, (entry, itemPath) => {
    const scope = str(errors, itemPath, entry, true, MAX_NAME_CHARS);
    if (scope === undefined) return undefined;
    if (!isKnownScope(scope)) {
      errors.add(itemPath, "is not a scope this deployment's OAuth client can request");
      return undefined;
    }
    return scope;
  });
  const label = localized(errors, `${path}.label`, raw.label, true);
  const scenario = localized(errors, `${path}.scenario`, raw.scenario, true);
  const scope = oneOf(errors, `${path}.scope`, raw.scope, PERMISSION_SCOPES, true);
  const level = oneOf(errors, `${path}.level`, raw.level, PERMISSION_LEVELS, true);
  // An empty list is legitimate: it marks an authority OAuth cannot grant, which
  // the wizard collects by hand instead.
  if (oauthScopes) requireUnique(errors, `${path}.oauthScopes`, oauthScopes, (entry) => entry, "scope");
  if (!key || !requirement || !oauthScopes || !label || !scenario || !scope || !level) return undefined;
  return { key, requirement, oauthScopes, label, scenario, scope, level };
}

function check(errors: Errors, path: string, value: unknown): RecipeCheck | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const id = matching(errors, `${path}.id`, raw.id, RECIPE_LIMITS.idPattern, true);
  const requirement = oneOf<Requirement>(errors, `${path}.requirement`, raw.requirement, REQUIREMENTS, true);
  const label = localized(errors, `${path}.label`, raw.label, true);
  const cfPath = apiPath(errors, `${path}.path`, raw.path);
  const hint = raw.hint === undefined ? undefined : localized(errors, `${path}.hint`, raw.hint, false);
  let actionUrl: string | undefined;
  if (raw.actionUrl !== undefined) {
    const value = str(errors, `${path}.actionUrl`, raw.actionUrl, false, MAX_NAME_CHARS);
    if (value !== undefined && !value.startsWith("https://dash.cloudflare.com/")) {
      errors.add(`${path}.actionUrl`, "must be a https://dash.cloudflare.com/ link");
    } else {
      actionUrl = value;
    }
  }
  if (!id || !requirement || !label || !cfPath) return undefined;
  return { id, requirement, label, path: cfPath, ...(hint === undefined ? {} : { hint }), ...(actionUrl === undefined ? {} : { actionUrl }) };
}

/**
 * The match declaration decides which existing resource a deployment will write
 * into, so an unusable one is rejected rather than skipped: a package that meant
 * to adopt an old database and got its pattern wrong should say so at the door,
 * not deploy against an empty one.
 */
function resourceMatch(errors: Errors, path: string, value: unknown): RecipeResourceMatch | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;

  const names =
    raw.names === undefined
      ? undefined
      : items(errors, `${path}.names`, raw.names, RECIPE_LIMITS.maxMatchNames, true, (entry, itemPath) =>
          interpolatedName(errors, itemPath, entry),
        );

  const patterns =
    raw.patterns === undefined
      ? undefined
      : items(errors, `${path}.patterns`, raw.patterns, RECIPE_LIMITS.maxMatchPatterns, true, (entry, itemPath) => {
          const source = str(errors, itemPath, entry, true, RECIPE_LIMITS.maxPatternChars);
          if (source === undefined) return undefined;
          try {
            new RegExp(source);
          } catch {
            errors.add(itemPath, "is not a valid regular expression");
            return undefined;
          }
          return source;
        });

  if (names) requireUnique(errors, `${path}.names`, names, (entry) => entry, "match name");
  if (patterns) requireUnique(errors, `${path}.patterns`, patterns, (entry) => entry, "match pattern");

  if ((names?.length || 0) === 0 && (patterns?.length || 0) === 0) {
    errors.add(path, "must name at least one name or pattern");
    return undefined;
  }
  return {
    ...(names === undefined || names.length === 0 ? {} : { names }),
    ...(patterns === undefined || patterns.length === 0 ? {} : { patterns }),
  };
}

function resource(errors: Errors, path: string, value: unknown): RecipeResource | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const id = matching(errors, `${path}.id`, raw.id, RECIPE_LIMITS.idPattern, true);
  const kind = oneOf<ResourceKind>(errors, `${path}.kind`, raw.kind, RESOURCE_KINDS, true);
  const binding = matching(errors, `${path}.binding`, raw.binding, RECIPE_LIMITS.bindingPattern, true);
  const defaultName = interpolatedName(errors, `${path}.defaultName`, raw.defaultName);
  const required = bool(errors, `${path}.required`, raw.required, true);
  const label = localized(errors, `${path}.label`, raw.label, true);
  const help = raw.help === undefined ? undefined : localized(errors, `${path}.help`, raw.help, false);
  const match = raw.match === undefined ? undefined : resourceMatch(errors, `${path}.match`, raw.match);
  let s3Keys: Requirement | undefined;
  if (raw.s3Keys !== undefined) {
    s3Keys = oneOf<Requirement>(errors, `${path}.s3Keys`, raw.s3Keys, REQUIREMENTS, false);
    if (kind && kind !== "r2") errors.add(`${path}.s3Keys`, "is only valid on an r2 resource");
  }
  if (!id || !kind || !binding || !defaultName || required === undefined || !label) return undefined;
  return {
    id,
    kind,
    binding,
    defaultName,
    required,
    label,
    ...(help === undefined ? {} : { help }),
    ...(match === undefined ? {} : { match }),
    ...(s3Keys === undefined ? {} : { s3Keys }),
  };
}

function workerVar(errors: Errors, path: string, value: unknown): RecipeVar | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const name = matching(errors, `${path}.name`, raw.name, RECIPE_LIMITS.bindingPattern, true);
  const varValue = str(errors, `${path}.value`, raw.value, false, MAX_STRING);
  if (!name || varValue === undefined) return undefined;
  return { name, value: varValue };
}

function container(errors: Errors, path: string, value: unknown): RecipeContainer | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const className = matching(errors, `${path}.className`, raw.className, RECIPE_LIMITS.bindingPattern, true);
  const mode = oneOf(errors, `${path}.mode`, raw.mode, CONTAINER_MODES, true);
  const note = raw.note === undefined ? undefined : localized(errors, `${path}.note`, raw.note, false);
  let image: RecipeContainerImage | undefined;
  if (raw.image !== undefined) {
    const imageRaw = bag(errors, `${path}.image`, raw.image, true);
    if (imageRaw) {
      const reference = str(errors, `${path}.image.reference`, imageRaw.reference, true, 320);
      if (reference !== undefined) {
        if (!DOCKER_IMAGE_RE.test(reference)) {
          errors.add(`${path}.image.reference`, "must be a fully-qualified immutable Docker Hub sha256 image digest");
        } else {
          image = { reference };
        }
      }
    }
  }
  if (!className || !mode) return undefined;
  return { className, mode, ...(note === undefined ? {} : { note }), ...(image === undefined ? {} : { image }) };
}

function worker(errors: Errors, path: string, value: unknown): RecipeWorker | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const defaultName = matching(errors, `${path}.defaultName`, raw.defaultName, RECIPE_LIMITS.namePattern, true);
  const module = packagePath(errors, `${path}.module`, raw.module, true);
  const assetsManifest =
    raw.assetsManifest === undefined ? undefined : packagePath(errors, `${path}.assetsManifest`, raw.assetsManifest, true);
  const assetsDir = raw.assetsDir === undefined ? undefined : packagePath(errors, `${path}.assetsDir`, raw.assetsDir, true);
  const assetHeaders =
    raw.assetHeaders === undefined ? undefined : packagePath(errors, `${path}.assetHeaders`, raw.assetHeaders, true);
  const compatibilityDate =
    raw.compatibilityDate === undefined
      ? undefined
      : matching(errors, `${path}.compatibilityDate`, raw.compatibilityDate, COMPAT_DATE_RE, true);
  const compatibilityFlags =
    raw.compatibilityFlags === undefined
      ? undefined
      : stringList(errors, `${path}.compatibilityFlags`, raw.compatibilityFlags, MAX_COMPAT_FLAGS, true, COMPAT_FLAG_RE);
  const vars =
    raw.vars === undefined
      ? undefined
      : items(errors, `${path}.vars`, raw.vars, RECIPE_LIMITS.maxVars, true, (entry, itemPath) =>
          workerVar(errors, itemPath, entry),
        );
  const containers =
    raw.containers === undefined
      ? undefined
      : items(errors, `${path}.containers`, raw.containers, RECIPE_LIMITS.maxContainers, true, (entry, itemPath) =>
          container(errors, itemPath, entry),
        );
  const assetsBinding =
    raw.assetsBinding === undefined
      ? undefined
      : matching(errors, `${path}.assetsBinding`, raw.assetsBinding, RECIPE_LIMITS.bindingPattern, true);
  if (vars) requireUnique(errors, `${path}.vars`, vars, (entry) => entry.name, "var name");
  if (containers) requireUnique(errors, `${path}.containers`, containers, (entry) => entry.className, "container class");
  if (!defaultName || !module) return undefined;
  return {
    defaultName,
    module,
    ...(assetsManifest === undefined ? {} : { assetsManifest }),
    ...(assetsDir === undefined ? {} : { assetsDir }),
    ...(assetHeaders === undefined ? {} : { assetHeaders }),
    ...(compatibilityDate === undefined ? {} : { compatibilityDate }),
    ...(compatibilityFlags === undefined ? {} : { compatibilityFlags }),
    ...(vars === undefined ? {} : { vars }),
    ...(containers === undefined ? {} : { containers }),
    ...(assetsBinding === undefined ? {} : { assetsBinding }),
  };
}

function inputField(errors: Errors, path: string, value: unknown): RecipeInput | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const id = matching(errors, `${path}.id`, raw.id, RECIPE_LIMITS.idPattern, true);
  const kind = oneOf<InputKind>(errors, `${path}.kind`, raw.kind, INPUT_KINDS, true);
  const label = localized(errors, `${path}.label`, raw.label, true);
  const help = raw.help === undefined ? undefined : localized(errors, `${path}.help`, raw.help, false);
  const required = raw.required === undefined ? undefined : bool(errors, `${path}.required`, raw.required, true);
  const onlyMode =
    raw.onlyMode === undefined ? undefined : oneOf<DeployMode>(errors, `${path}.onlyMode`, raw.onlyMode, DEPLOY_MODES, true);
  let visibleWhen: RecipeInput["visibleWhen"];
  if (raw.visibleWhen !== undefined) {
    const condition = bag(errors, `${path}.visibleWhen`, raw.visibleWhen, true);
    if (condition) {
      const input = matching(errors, `${path}.visibleWhen.input`, condition.input, RECIPE_LIMITS.idPattern, true);
      const equals = condition.equals;
      const mode =
        condition.mode === undefined
          ? undefined
          : oneOf<DeployMode>(errors, `${path}.visibleWhen.mode`, condition.mode, DEPLOY_MODES, true);
      if (typeof equals !== "string" && typeof equals !== "boolean") {
        errors.add(`${path}.visibleWhen.equals`, "must be a string or boolean");
      } else if (input) {
        visibleWhen = { input, equals, ...(mode === undefined ? {} : { mode }) };
      }
    }
  }

  let fallback: string | boolean | undefined;
  if (raw.default !== undefined) {
    if (kind === "toggle") fallback = bool(errors, `${path}.default`, raw.default, true);
    else fallback = str(errors, `${path}.default`, raw.default, false, MAX_STRING);
  }

  let pattern: string | undefined;
  if (raw.pattern !== undefined) {
    pattern = str(errors, `${path}.pattern`, raw.pattern, true, 512);
    if (pattern !== undefined) {
      try {
        new RegExp(pattern);
      } catch {
        errors.add(`${path}.pattern`, "is not a valid regular expression");
        pattern = undefined;
      }
    }
  }

  let options: Array<{ value: string; label: Localized }> | undefined;
  if (raw.options !== undefined) {
    options = items(errors, `${path}.options`, raw.options, MAX_INPUT_OPTIONS, true, (entry, itemPath) => {
      const option = bag(errors, itemPath, entry, true);
      if (!option) return undefined;
      const optionValue = str(errors, `${itemPath}.value`, option.value, true, MAX_NAME_CHARS);
      const optionLabel = localized(errors, `${itemPath}.label`, option.label, true);
      if (optionValue === undefined || !optionLabel) return undefined;
      return { value: optionValue, label: optionLabel };
    });
    if (options) requireUnique(errors, `${path}.options`, options, (entry) => entry.value, "option value");
  }
  if (kind === "select" && (!options || options.length === 0)) {
    errors.add(`${path}.options`, "is required for a select input");
  }

  let generate: number | undefined;
  if (raw.generate !== undefined) {
    generate = integer(errors, `${path}.generate`, raw.generate, 4, 128);
    if (kind && kind !== "password") errors.add(`${path}.generate`, "is only valid on a password input");
  }

  if (!id || !kind || !label) return undefined;
  return {
    id,
    kind,
    label,
    ...(help === undefined ? {} : { help }),
    ...(fallback === undefined ? {} : { default: fallback }),
    ...(required === undefined ? {} : { required }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(options === undefined ? {} : { options }),
    ...(onlyMode === undefined ? {} : { onlyMode }),
    ...(visibleWhen === undefined ? {} : { visibleWhen }),
    ...(generate === undefined ? {} : { generate }),
  };
}

function hostSecret(errors: Errors, path: string, value: unknown): RecipeHostSecret | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const name = matching(errors, `${path}.name`, raw.name, RECIPE_LIMITS.bindingPattern, true);
  const source = oneOf<HostSecretSource>(errors, `${path}.source`, raw.source, HOST_SECRET_SOURCES, true);
  const reason = localized(errors, `${path}.reason`, raw.reason, true);
  const requirement = oneOf<Requirement>(errors, `${path}.requirement`, raw.requirement, REQUIREMENTS, true);

  // `permissions` is the app token's own permission request, in template
  // `{ key, type }` form — it belongs to `cfApiToken` and to nothing else. A key
  // outside CF_TOKEN_PERMISSIONS could never resolve on Cloudflare's own token
  // page, so a package naming one is rejected here rather than silently missing
  // from the pre-fill.
  let permissions: CfTokenPermissionRequest[] | undefined;
  if (source === "cfApiToken") {
    permissions = items(errors, `${path}.permissions`, raw.permissions, MAX_TOKEN_PERMISSIONS, true, (entry, itemPath) => {
      const r = bag(errors, itemPath, entry, true);
      if (!r) return undefined;
      const key = str(errors, `${itemPath}.key`, r.key, true, MAX_NAME_CHARS);
      const type = oneOf<"read" | "edit">(errors, `${itemPath}.type`, r.type, TOKEN_PERM_TYPES, true);
      const requirement = r.requirement === undefined ? undefined : oneOf<Requirement>(errors, `${itemPath}.requirement`, r.requirement, REQUIREMENTS, true);
      const scenario = r.scenario === undefined ? undefined : localized(errors, `${itemPath}.scenario`, r.scenario, true);
      if (key !== undefined && !isKnownTokenPermission(key)) {
        errors.add(`${itemPath}.key`, "is not a Cloudflare token permission this deployment can request");
        return undefined;
      }
      if (key === undefined || !type) return undefined;
      return { key, type, ...(requirement ? { requirement } : {}), ...(scenario ? { scenario } : {}) };
    });
    if (permissions && permissions.length === 0) errors.add(`${path}.permissions`, "must name at least one permission");
    if (permissions) requireUnique(errors, `${path}.permissions`, permissions, (e) => `${e.key}:${e.type}`, "permission");
  } else if (raw.permissions !== undefined) {
    errors.add(`${path}.permissions`, "is only valid on a cfApiToken host secret");
  }

  if (!name || !source || !reason || !requirement) return undefined;
  if (source === "cfApiToken" && (!permissions || permissions.length === 0)) return undefined;
  return { name, source, reason, requirement, ...(permissions === undefined ? {} : { permissions }) };
}

function step(errors: Errors, path: string, value: unknown): RecipeStep | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const id = matching(errors, `${path}.id`, raw.id, RECIPE_LIMITS.idPattern, true);
  const label = localized(errors, `${path}.label`, raw.label, true);
  const weight = raw.weight === undefined ? undefined : integer(errors, `${path}.weight`, raw.weight, 1, 100);
  const optional = raw.optional === undefined ? undefined : bool(errors, `${path}.optional`, raw.optional, true);
  if (!id || !label) return undefined;
  return { id, label, ...(weight === undefined ? {} : { weight }), ...(optional === undefined ? {} : { optional }) };
}

function license(errors: Errors, path: string, value: unknown): RecipeLicense | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const id = matching(errors, `${path}.id`, raw.id, SPDX_RE, true);
  const text = str(errors, `${path}.text`, raw.text, true, RECIPE_LIMITS.maxLicenseChars);
  if (!id || text === undefined) return undefined;
  return { id, text };
}

/**
 * `texts` picks the locale text the same way `localized()` does elsewhere —
 * exact locale, then `*`. When acceptance is required, at least one of those
 * two has to actually resolve to something, or a locale the wizard cannot
 * satisfy would silently let the user past terms they never saw.
 */
function terms(errors: Errors, path: string, value: unknown): RecipeTerms | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const required = bool(errors, `${path}.required`, raw.required, true);
  const textsBag = bag(errors, `${path}.texts`, raw.texts, true);
  let texts: Record<string, string> | undefined;
  if (textsBag) {
    const entries = Object.entries(textsBag);
    if (entries.length === 0) errors.add(`${path}.texts`, "must name at least one locale");
    if (entries.length > MAX_LOCALE_ENTRIES) errors.add(`${path}.texts`, `must have at most ${MAX_LOCALE_ENTRIES} locales`);
    const out: Record<string, string> = {};
    for (const [locale, entry] of entries.slice(0, MAX_LOCALE_ENTRIES)) {
      if (!LOCALE_KEY_RE.test(locale)) {
        errors.add(`${path}.texts.${locale}`, "is not a locale tag");
        continue;
      }
      const checked = str(errors, `${path}.texts.${locale}`, entry, true, RECIPE_LIMITS.maxTermsChars);
      if (checked !== undefined) out[locale] = checked;
    }
    texts = out;
  }
  if (!texts || required === undefined) return undefined;
  if (required && !texts["*"] && Object.keys(texts).length === 0) {
    errors.add(`${path}.texts`, "must have text for at least one locale when required is true");
    return undefined;
  }
  return { texts, required };
}

function packageRef(errors: Errors, path: string, value: unknown): PackageRef | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const artifact = str(errors, `${path}.artifact`, raw.artifact, true, MAX_NAME_CHARS);
  if (artifact !== undefined && artifact !== PACKAGE_ARTIFACT_NAME) {
    errors.add(`${path}.artifact`, `must be ${PACKAGE_ARTIFACT_NAME}`);
  }
  const sha256 = matching(errors, `${path}.sha256`, raw.sha256, SHA256_RE, true);
  const bytes = raw.bytes === undefined ? undefined : integer(errors, `${path}.bytes`, raw.bytes, 0, Number.MAX_SAFE_INTEGER);
  if (!artifact || artifact !== PACKAGE_ARTIFACT_NAME || !sha256) return undefined;
  return { artifact, sha256: sha256.toLowerCase(), ...(bytes === undefined ? {} : { bytes }) };
}

/**
 * Done-page links are rendered as anchors, so the href is restricted to the
 * deployed URL or an https address — a `javascript:` href would otherwise run
 * in the host frame, which is exactly what the sandbox exists to prevent.
 */
function doneLink(errors: Errors, path: string, value: unknown): RecipeDoneLink | undefined {
  const raw = bag(errors, path, value, true);
  if (!raw) return undefined;
  const label = localized(errors, `${path}.label`, raw.label, true);
  const href = str(errors, `${path}.href`, raw.href, true, 512);
  if (href !== undefined && !href.startsWith("${url}") && !href.startsWith("https://")) {
    errors.add(`${path}.href`, "must start with ${url} or https://");
    return undefined;
  }
  if (!label || href === undefined) return undefined;
  return { label, href };
}

// ---------------------------------------------------------------------------

export function validateRecipe(input: unknown): { ok: true; recipe: Recipe } | { ok: false; errors: string[] } {
  const errors = new Errors();
  const raw = bag(errors, "recipe", input, true);
  if (!raw) return { ok: false, errors: errors.list };

  if (raw.schema !== RECIPE_SCHEMA) errors.add("schema", `must be ${RECIPE_SCHEMA}`);

  const id = matching(errors, "id", raw.id, RECIPE_LIMITS.idPattern, true);
  const name = str(errors, "name", raw.name, true, 120);
  const summary = localized(errors, "summary", raw.summary, true);
  const homepage = raw.homepage === undefined ? undefined : httpsUrl(errors, "homepage", raw.homepage);
  const version = str(errors, "version", raw.version, true, 64);
  const tag = str(errors, "tag", raw.tag, true, 64);
  const buildTime = str(errors, "buildTime", raw.buildTime, true, 64);
  const packageField = packageRef(errors, "package", raw.package);

  const licenseField = license(errors, "license", raw.license);

  const termsField = raw.terms === undefined ? undefined : terms(errors, "terms", raw.terms);

  const authModes = items<AuthMode>(errors, "authModes", raw.authModes, AUTH_MODES.length, true, (entry, path) => {
    const text = str(errors, path, entry, true, 20);
    if (text === undefined) return undefined;
    if (!(AUTH_MODES as readonly string[]).includes(text)) {
      errors.add(path, "is not an authentication mode this wizard offers");
      return undefined;
    }
    return text as AuthMode;
  });
  if (authModes && authModes.length === 0) errors.add("authModes", "must name at least one authentication mode");
  if (authModes) requireUnique(errors, "authModes", authModes, (entry) => entry, "authentication mode");

  const permissions = items(errors, "permissions", raw.permissions, RECIPE_LIMITS.maxPermissions, true, (entry, path) =>
    permission(errors, path, entry),
  );
  const checks =
    raw.checks === undefined
      ? undefined
      : items(errors, "checks", raw.checks, RECIPE_LIMITS.maxChecks, true, (entry, path) => check(errors, path, entry));
  const resources = items(errors, "resources", raw.resources, RECIPE_LIMITS.maxResources, true, (entry, path) =>
    resource(errors, path, entry),
  );
  const workerSection = worker(errors, "worker", raw.worker);
  const inputs =
    raw.inputs === undefined
      ? undefined
      : items(errors, "inputs", raw.inputs, RECIPE_LIMITS.maxInputs, true, (entry, path) => inputField(errors, path, entry));

  const capabilities = items<Capability>(errors, "capabilities", raw.capabilities, CAPABILITIES.size, true, (entry, path) => {
    const text = str(errors, path, entry, true, 40);
    if (text === undefined) return undefined;
    if (!CAPABILITIES.has(text)) {
      errors.add(path, "is not a capability this wizard grants");
      return undefined;
    }
    return text as Capability;
  });

  const hostSecrets =
    raw.hostSecrets === undefined
      ? undefined
      : items(errors, "hostSecrets", raw.hostSecrets, RECIPE_LIMITS.maxHostSecrets, true, (entry, path) =>
          hostSecret(errors, path, entry),
        );
  const steps = items(errors, "steps", raw.steps, RECIPE_LIMITS.maxSteps, true, (entry, path) => step(errors, path, entry));
  const script = raw.script === undefined ? undefined : packagePath(errors, "script", raw.script, true);

  let health: Recipe["health"];
  if (raw.health !== undefined) {
    const healthBag = bag(errors, "health", raw.health, true);
    const healthPath = healthBag && str(errors, "health.path", healthBag.path, true, MAX_PATH_CHARS);
    if (healthPath !== undefined && healthPath) {
      if (!healthPath.startsWith("/") || healthPath.includes("://") || healthPath.includes("\\")) {
        errors.add("health.path", "must be a path beginning with /");
      } else {
        health = { path: healthPath };
      }
    }
  }

  let done: Recipe["done"];
  if (raw.done !== undefined) {
    const doneBag = bag(errors, "done", raw.done, true);
    if (doneBag) {
      const links =
        doneBag.links === undefined
          ? undefined
          : items(errors, "done.links", doneBag.links, RECIPE_LIMITS.maxDoneLinks, true, (entry, path) =>
              doneLink(errors, path, entry),
            );
      const notes = doneBag.notes === undefined ? undefined : localized(errors, "done.notes", doneBag.notes, false);
      done = { ...(links === undefined ? {} : { links }), ...(notes === undefined ? {} : { notes }) };
    }
  }

  if (steps && steps.length === 0) errors.add("steps", "must declare at least one step");
  if (steps) requireUnique(errors, "steps", steps, (entry) => entry.id, "step id");
  if (resources) {
    requireUnique(errors, "resources", resources, (entry) => entry.id, "resource id");
    requireUnique(errors, "resources", resources, (entry) => entry.binding, "resource binding");
  }
  if (inputs) requireUnique(errors, "inputs", inputs, (entry) => entry.id, "input id");
  if (inputs) {
    const knownInputIds = new Set(inputs.map((entry) => entry.id));
    for (const [index, entry] of inputs.entries()) {
      if (entry.visibleWhen && !knownInputIds.has(entry.visibleWhen.input)) {
        errors.add(`inputs[${index}].visibleWhen.input`, "must name a declared input");
      }
    }
  }
  if (capabilities) requireUnique(errors, "capabilities", capabilities, (entry) => entry, "capability");
  if (hostSecrets) requireUnique(errors, "hostSecrets", hostSecrets, (entry) => entry.name, "host secret name");

  // A cfApiToken host secret is a long-lived app credential, which oauth cannot
  // furnish — so a recipe that needs one has to offer a mode that can.
  if (
    hostSecrets &&
    authModes &&
    authModes.length > 0 &&
    hostSecrets.some((secret) => secret.source === "cfApiToken") &&
    !authModes.some((mode) => mode === "auto")
  ) {
    errors.add("authModes", "must include \"auto\" when a cfApiToken host secret is declared");
  }

  if (
    errors.list.length > 0 ||
    !id ||
    name === undefined ||
    !summary ||
    version === undefined ||
    !tag ||
    !buildTime ||
    !packageField ||
    !licenseField ||
    !authModes ||
    authModes.length === 0 ||
    !permissions ||
    !resources ||
    !workerSection ||
    !capabilities ||
    !steps
  ) {
    if (errors.list.length === 0) errors.add("recipe", "is incomplete");
    return { ok: false, errors: errors.list };
  }

  return {
    ok: true,
    recipe: {
      schema: RECIPE_SCHEMA,
      id,
      name,
      summary,
      ...(homepage === undefined ? {} : { homepage }),
      version,
      tag,
      buildTime,
      package: packageField,
      license: licenseField,
      ...(termsField === undefined ? {} : { terms: termsField }),
      authModes,
      permissions,
      ...(checks === undefined ? {} : { checks }),
      resources,
      worker: workerSection,
      ...(inputs === undefined ? {} : { inputs }),
      capabilities,
      ...(hostSecrets === undefined ? {} : { hostSecrets }),
      steps,
      ...(script === undefined ? {} : { script }),
      ...(health === undefined ? {} : { health }),
      ...(done === undefined ? {} : { done }),
    },
  };
}
