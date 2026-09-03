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

// The capability gate is the whole security boundary around a package's
// recipe.js. A method the host routes without a gate entry, or a credential
// field that reaches the guest context, is a hole — both are checked here, the
// second by reading the source, since types leave nothing behind at runtime.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { METHOD_GATES, BRIDGE_LIMITS, BRIDGE_PROTOCOL } from "../../src/lib/sandbox/protocol";

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

const protocolSource = read("src/lib/sandbox/protocol.ts");
const recipeTypesSource = read("src/lib/recipe/types.ts");
const hostSource = read("src/lib/sandbox/host.ts");
const runSource = read("src/lib/engine/run.ts");

/** Values of a `export type X = "a" | "b"` union, which runtime cannot see. */
function unionValues(source: string, name: string): string[] {
  const at = source.indexOf(`export type ${name} =`);
  if (at < 0) return [];
  const end = source.indexOf(";", at);
  return [...source.slice(at, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Body of a brace-delimited declaration, from its `{` to the matching `}`. */
function blockAfter(source: string, needle: string): string {
  const at = source.indexOf(needle);
  if (at < 0) return "";
  const open = source.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

/** The object literal enclosing `needle`, used to inspect what run.ts assembles. */
function literalAround(source: string, needle: string): string | null {
  const at = source.indexOf(needle);
  if (at < 0) return null;
  const open = source.lastIndexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

const capabilities = unionValues(recipeTypesSource, "Capability");

// The host router names the UI-only methods after what they touch rather than
// after the ergonomic wrapper the guest calls, so the two spellings are mapped
// here instead of being guessed from the interface.
const TOP_LEVEL_GATE_NAMES: Record<string, string> = {
  step: "step.set",
  progress: "step.progress",
  result: "result.set",
  file: "pkg.file",
  text: "pkg.text",
};

/** Every method reachable on RecipeContext, spelled as a METHOD_GATES key. */
function contextMethods(): string[] {
  const body = blockAfter(protocolSource, "export interface RecipeContext");
  const found: string[] = [];
  let namespace = "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    const opening = line.match(/^([A-Za-z_]\w*):\s*\{$/);
    if (opening) {
      namespace = opening[1];
      continue;
    }
    if (line.startsWith("}")) {
      namespace = "";
      continue;
    }
    const method = line.match(/^([A-Za-z_]\w*)\s*\(/);
    if (!method) continue;
    const name = method[1];
    found.push(namespace ? `${namespace}.${name}` : TOP_LEVEL_GATE_NAMES[name] || name);
  }
  return found;
}

const methods = contextMethods();
const gateKeys = Object.keys(METHOD_GATES);
// "apiToken" is gone from this list on purpose, not because the field moved
// elsewhere: the session credential is an HttpOnly cookie this frame never
// holds as a value in the first place, so there is no string left to check
// for. What is still checked is that the fields that *do* reach this frame
// (the account id, the R2 S3 pair) never leak into the sandbox.
const CREDENTIAL_FIELDS = ["accountId", "r2AccessKeyId", "r2SecretAccessKey"];
const guestContextBlock = blockAfter(protocolSource, "export interface GuestContext");
// Anchored on the field, not the imported name, so the import's own braces
// cannot be mistaken for the literal.
const guestLiteral = literalAround(runSource, "protocol: BRIDGE_PROTOCOL");
/** Comments discuss allow-same-origin; only real code may not use it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const hostCode = withoutComments(hostSource);
const iframeSandbox = [
  ...hostCode.matchAll(/setAttribute\(\s*["'`]sandbox["'`]\s*,\s*["'`]([^"'`]*)["'`]/g),
  ...hostCode.matchAll(/\bsandbox\s*=\s*["'`]([^"'`]*)["'`]/g),
].map((match) => match[1]);

const checks: Array<[string, boolean, string?]> = [
  ["there is no log.write method left in the gate table", !gateKeys.includes("log.write")],
  ["RecipeContext exposes no log( method", !/\blog\s*\(/.test(blockAfter(protocolSource, "export interface RecipeContext"))],

  ["the recipe Capability union was found", capabilities.length > 0, "no Capability union in recipe/types.ts"],
  ["every gate names a real capability",
    gateKeys.every((key) => METHOD_GATES[key] === null || capabilities.includes(METHOD_GATES[key] as string)),
    gateKeys.filter((key) => METHOD_GATES[key] !== null && !capabilities.includes(METHOD_GATES[key] as string)).join(", ")],
  ["privileged and ungated methods are both present",
    gateKeys.some((key) => METHOD_GATES[key] === null) && gateKeys.some((key) => METHOD_GATES[key] !== null)],

  ["RecipeContext methods were found", methods.length > 0, "could not parse the RecipeContext interface"],
  ["every RecipeContext method has a gate entry",
    methods.every((method) => gateKeys.includes(method)),
    methods.filter((method) => !gateKeys.includes(method)).join(", ")],
  ["no gate entry names a method the context does not expose",
    gateKeys.every((key) => methods.includes(key)),
    gateKeys.filter((key) => !methods.includes(key)).join(", ")],
  ["Cloudflare-touching namespaces are gated, not ungated",
    ["d1", "r2", "kv", "secrets", "worker", "assets", "cron", "domains", "probe"].every((namespace) =>
      gateKeys.some((key) => key.startsWith(`${namespace}.`))
      && gateKeys.filter((key) => key.startsWith(`${namespace}.`)).every((key) => METHOD_GATES[key] !== null))],

  ["there is no log line budget left in BRIDGE_LIMITS",
    !("maxLogLines" in BRIDGE_LIMITS) && !("maxLogLineChars" in BRIDGE_LIMITS)],
  ["BRIDGE_LIMITS caps failure text length with a positive maxErrorChars",
    typeof BRIDGE_LIMITS.maxErrorChars === "number" && BRIDGE_LIMITS.maxErrorChars > 0],

  ["the protocol version is a positive integer", Number.isInteger(BRIDGE_PROTOCOL) && BRIDGE_PROTOCOL > 0],
  ["every bridge budget is a positive number",
    Object.values(BRIDGE_LIMITS).every((value) => typeof value === "number" && Number.isFinite(value) && value > 0),
    Object.entries(BRIDGE_LIMITS).filter(([, value]) => !(typeof value === "number" && value > 0)).map(([key]) => key).join(", ")],
  ["the privileged call budget is no larger than the total call budget",
    BRIDGE_LIMITS.maxPrivilegedCalls <= BRIDGE_LIMITS.maxCalls],
  ["a single call cannot outlast the whole run", BRIDGE_LIMITS.callTimeoutMs <= BRIDGE_LIMITS.runTimeoutMs],

  ["the guest frame is sandboxed without allow-same-origin",
    iframeSandbox.length > 0
    && iframeSandbox.every((value) => value.split(/\s+/).includes("allow-scripts") && !value.includes("allow-same-origin"))
    && !/allow-same-origin/.test(hostCode),
    hostSource.length === 0
      ? "missing src/lib/sandbox/host.ts"
      : iframeSandbox.length === 0
        ? "no sandbox attribute assignment found"
        : iframeSandbox.join(" | ")],
  ["the guest frame is not handed any other escape hatch",
    hostSource.length > 0 && !/allow-top-navigation|allow-popups-to-escape-sandbox|allow-modals/.test(hostCode)],

  ["GuestContext declares no credential field",
    guestContextBlock.length > 0 && CREDENTIAL_FIELDS.every((field) => !guestContextBlock.includes(field)),
    guestContextBlock.length === 0 ? "could not parse GuestContext" : CREDENTIAL_FIELDS.filter((field) => guestContextBlock.includes(field)).join(", ")],
  ["credentials appear nowhere in the message types",
    (() => {
      const at = protocolSource.indexOf("// Messages");
      return at > 0 && CREDENTIAL_FIELDS.every((field) => !protocolSource.slice(at).includes(field));
    })()],
  ["the guest context run.ts builds carries no credential field",
    !!guestLiteral && CREDENTIAL_FIELDS.every((field) => !guestLiteral.includes(field)),
    runSource.length === 0
      ? "missing src/lib/engine/run.ts"
      : !guestLiteral
        ? "no GuestContext literal found in engine/run.ts"
        : CREDENTIAL_FIELDS.filter((field) => guestLiteral.includes(field)).join(", ")],
  ["sandbox failures pass through the capability host scrubber before becoming DeployError",
    /host\.scrubMessage\(outcome\.message\s*\|\|\s*"the recipe failed"\)/.test(runSource)],
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
