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

// What the wizard must keep telling the user: which authority a package is
// asking for, and what turning the source allowlist off means. Guarded at the
// source and copy level, because that is where these disclosures live.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const missing: string[] = [];

function read(file: string): string {
  try {
    return fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    missing.push(file);
    return "";
  }
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "vendor" || entry.name === "node_modules") continue;
      walk(rel, out);
    } else if (entry.name.endsWith(".vue")) {
      out.push(rel);
    }
  }
  return out;
}

const vueFiles = walk("src");
const byName = (pattern: RegExp) => vueFiles.filter((file) => pattern.test(path.basename(file)));

const policyFiles = byName(/policy/i);
const policySource = policyFiles.map((file) => read(file)).join("\n");

// The wizard's step components may be organised as one file per step or
// merged (Source+Package+Terms, Resources+Options); scan whatever is under
// steps/ instead of naming files, so reorganisation doesn't break this test.
const stepFiles = vueFiles.filter((file) => file.includes("/steps/"));
const stepsSource = stepFiles.map((file) => read(file)).join("\n");
const executeFiles = byName(/execute/i);
const executeSource = executeFiles.map((file) => read(file)).join("\n");

// The disclosure step is whichever step file shows both the host secrets the
// package will receive and the capabilities it is granted; find it by content
// rather than by file name, for the same reason.
const disclosureFiles = stepFiles.filter((file) => {
  const source = read(file);
  return source.includes("hostSecrets") && source.includes("capabilities");
});
const disclosureSource = disclosureFiles.map((file) => read(file)).join("\n");

const enText = read("src/locales/en.json");
const zhText = read("src/locales/zh-CN.json");

function parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const en = parse(enText);
const zh = parse(zhText);

function keyPaths(value: unknown, prefix = "", out: string[] = []): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) keyPaths(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.push(prefix);
  }
  return out;
}

const enKeys = en ? keyPaths(en) : [];
const zhKeys = zh ? keyPaths(zh) : [];
const onlyEn = enKeys.filter((key) => !zhKeys.includes(key));
const onlyZh = zhKeys.filter((key) => !enKeys.includes(key));

/** Every string value in a locale file, which is the whole of the UI copy. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") for (const child of Object.values(value)) strings(child, out);
  return out;
}

const copy = [...strings(en), ...strings(zh)];
const brandedCopy = copy.filter((line) => /edgesonic/i.test(line));
const brandedComponents = vueFiles.filter((file) => /edgesonic/i.test(read(file)));

/** Flattens a locale subtree into leaf path → string. */
function flatten(value: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (typeof value === "string") out[prefix] = value;
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const policyCopy = flatten(en?.policy);
// Either the key or the sentence has to read as a warning; the page then has to
// actually render it.
const policyWarnings = Object.entries(policyCopy).filter(
  ([key, value]) => /warn|risk|danger|caution/i.test(key) || /\brisk|\bwarn|any repositor|arbitrary/i.test(value),
);
const policyWarningKeys = policyWarnings.map(([key]) => key);

// Every t("…") with a literal key, across the whole UI. Keys built from a
// template literal are the component's own business and are skipped.
const usedKeys = [
  ...new Set(
    vueFiles.flatMap((file) => [...read(file).matchAll(/\bt\("([A-Za-z0-9_.]+)"/g)].map((match) => match[1])),
  ),
];
const danglingKeys = usedKeys.filter((key) => !enKeys.includes(key));

/** `{name}` placeholders, which have to agree or one locale renders a literal brace. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
}
const enFlat = flatten(en);
const zhFlat = flatten(zh);
const placeholderMismatches = Object.keys(enFlat)
  .filter((key) => zhFlat[key] !== undefined)
  .filter((key) => placeholders(enFlat[key]).join(",") !== placeholders(zhFlat[key]).join(","));

const checks: Array<[string, boolean, string?]> = [
  ["every message key a component asks for exists", danglingKeys.length === 0, danglingKeys.join(", ")],
  ["the two locales interpolate the same values", placeholderMismatches.length === 0, placeholderMismatches.join(", ")],

  ["both locale files parse as JSON objects", !!en && !!zh,
    `${en ? "" : "en.json unparseable "}${zh ? "" : "zh-CN.json unparseable"}`],
  ["the locale key sets are identical", enKeys.length > 0 && onlyEn.length === 0 && onlyZh.length === 0,
    `en only: ${onlyEn.join(", ") || "none"}; zh-CN only: ${onlyZh.join(", ") || "none"}`],
  ["no locale key holds an empty string",
    copy.length > 0 && copy.every((line) => line.trim().length > 0)],

  ["no UI copy names a particular deployable package", brandedCopy.length === 0, brandedCopy.join(" | ")],
  ["no component hardcodes a particular deployable package", brandedComponents.length === 0, brandedComponents.join(", ")],

  ["the step that discloses capabilities and host secrets exists", disclosureFiles.length > 0,
    "no step under src/**/steps/ references both hostSecrets and capabilities"],
  ["the step that discloses capabilities and host secrets shows the host secrets the package will receive",
    disclosureSource.includes("hostSecrets"),
    disclosureFiles.join(", ")],
  ["the step that discloses capabilities and host secrets shows the capabilities the recipe script is granted",
    disclosureSource.includes("capabilities")],
  ["the step that discloses capabilities and host secrets names the resources and the worker being written to",
    disclosureSource.includes("resources") && disclosureSource.includes("worker")],
  ["review copy exists in both locales", (() => {
    const match = /t\("([a-zA-Z0-9_]+)\.capabilitiesTitle"\)/.exec(disclosureSource);
    if (!match) return false;
    const ns = match[1];
    return enKeys.some((key) => key.startsWith(`${ns}.`)) && zhKeys.some((key) => key.startsWith(`${ns}.`));
  })(),
    (() => {
      const match = /t\("([a-zA-Z0-9_]+)\.capabilitiesTitle"\)/.exec(disclosureSource);
      return match ? `namespace "${match[1]}" missing from a locale` : "no t(\"<ns>.capabilitiesTitle\") reference found in the disclosure step";
    })()],

  ["a policy page exists", policyFiles.length > 0, "no *Policy*.vue under src"],
  ["the policy page warns about turning the source allowlist off",
    policyWarningKeys.length > 0 && policyWarningKeys.some((key) => policySource.includes(key)),
    policyWarningKeys.length === 0 ? "no warning key under en.policy" : `keys ${policyWarningKeys.join(", ")} unused by ${policyFiles.join(", ")}`],
  ["the allowlist toggle is rendered as a deliberate choice",
    /allowlistEnabled/.test(policySource)],
  ["the warning copy states what a disabled allowlist permits",
    policyWarnings.some(([, value]) => /any repositor|any GitHub|arbitrary/i.test(value)),
    policyWarnings.map(([key]) => key).join(", ")],

  ["the policy page is read-only: no input, no save affordance",
    policyFiles.length > 0
    && !/<input\b/i.test(policySource)
    && !/@click\s*=\s*"?\s*save/i.test(policySource)
    && !/unlockPolicy|putPolicy/.test(policySource),
    policyFiles.join(", ")],

  ["the execute page shows no log panel", executeFiles.length === 0 || (
    !/appendLog|logLines|log-block/.test(executeSource)
  ), executeFiles.join(", ")],

  ["a step component's copy references the package's own terms-of-service section",
    stepFiles.length > 0 && /\.termsSection\b/.test(stepsSource),
    stepFiles.join(", ")],
];

let failures = 0;
for (const [label, passed, detail] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

if (missing.length > 0) console.error(`  missing source files: ${missing.join(", ")}`);
console.log(`${checks.length - failures}/${checks.length} assertions passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
