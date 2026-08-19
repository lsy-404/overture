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

// A read of the package's recipe.js, done before anything runs it.
//
// What this can and cannot claim matters more here than anywhere else in the
// wizard, because the answer is shown to a user deciding whether to point a
// stranger's code at their own Cloudflare account:
//
//   - What it finds, it found. A capability call or a network target reported
//     here really is written in the script.
//   - What it does not find may still be there. `obj[name]()`, a URL assembled
//     at runtime, `eval` — all of these defeat a static read, so each one sets
//     `certain` false, and the report says so rather than showing an empty list
//     as if it were a clean bill of health.
//
// The scan errs towards reporting: an accessor chain is matched on its tail, so
// a call on something that merely looks like the recipe context counts. A false
// "this package touches D1" is a bad report; a missed one is a bad promise.

import { parse } from "acorn";
import { METHOD_GATES } from "../sandbox/protocol";

const MAX_TARGETS = 40;
const MAX_TEXT = 120;

/** RecipeContext accessors whose name differs from the bridge method they call. */
const ACCESSOR_ALIASES: Record<string, string> = {
  step: "step.set",
  progress: "step.progress",
  result: "result.set",
  file: "pkg.file",
  text: "pkg.text",
};

/**
 * Accessor path as written in a recipe → bridge method. Built from the bridge's
 * own table so a method added there becomes detectable here without an edit.
 */
const ACCESSORS: Map<string, string> = (() => {
  const aliased = new Set(Object.values(ACCESSOR_ALIASES));
  const out = new Map<string, string>();
  for (const method of Object.keys(METHOD_GATES)) if (!aliased.has(method)) out.set(method, method);
  for (const [accessor, method] of Object.entries(ACCESSOR_ALIASES)) out.set(accessor, method);
  return out;
})();

/** Globals that reach the network. `fetch` is the only one the frame's CSP admits. */
const NETWORK_CALLS = new Set(["fetch"]);
const NETWORK_CONSTRUCTORS = new Set(["WebSocket", "EventSource", "XMLHttpRequest", "Worker", "SharedWorker"]);
const NETWORK_TAILS = new Set(["navigator.sendBeacon", "sendBeacon"]);
/** Anything that turns data into running code, so a later read of the source proves less. */
const DYNAMIC_CODE_CALLS = new Set(["eval", "Function"]);
const DYNAMIC_CODE_TAILS = new Set(["URL.createObjectURL", "createObjectURL"]);

export interface NetworkTarget {
  /** `https://host:port`, or the raw text when it could not be parsed. */
  origin: string;
  /** How it is reached: fetch, WebSocket, sendBeacon, … */
  via: string;
  /** The address is assembled at runtime, so this is only its literal prefix. */
  partial: boolean;
}

export interface ScriptScan {
  /** False when recipe.js does not parse at all — nothing below is meaningful. */
  parsed: boolean;
  /** Parse failure text, for the one case where the package is simply broken. */
  parseError?: string;
  /**
   * False when the script contains constructs a static read cannot follow, so
   * the lists below are a lower bound rather than the whole story.
   */
  certain: boolean;
  /** Bridge methods the script calls, as METHOD_GATES names them. */
  methods: Set<string>;
  /** Hosts the script contacts on its own, outside the capability bridge. */
  network: NetworkTarget[];
  /** Network calls whose address could not be read at all. */
  opaqueNetwork: number;
  /** `eval`, `new Function`, dynamic `import()`, Blob URLs. */
  dynamicCode: boolean;
  /** Computed member access (`obj[name]()`), which hides the accessor name. */
  computedAccess: boolean;
}

type Node = Record<string, unknown> & { type: string };

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw"]);

/**
 * Iterative rather than recursive: recipe.js can be half a megabyte of
 * arbitrarily nested expressions, and a blown stack would read as "no findings".
 */
function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    visit(node);
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item);
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
}

/** The dotted name of a member chain, plus whether any link was computed. */
function accessorChain(node: Node): { path: string[]; computed: boolean } {
  const path: string[] = [];
  let computed = false;
  let current: Node | undefined = node;
  while (current) {
    if (current.type === "Identifier") {
      path.unshift(String(current.name));
      break;
    }
    if (current.type === "ThisExpression") {
      path.unshift("this");
      break;
    }
    if (current.type !== "MemberExpression") break;
    const property = current.property;
    if (current.computed === true) {
      computed = true;
      // A computed key that is a plain string still names one accessor.
      if (isNode(property) && property.type === "Literal" && typeof property.value === "string") {
        path.unshift(property.value);
      } else {
        path.unshift("*");
      }
    } else if (isNode(property) && property.type === "Identifier") {
      path.unshift(String(property.name));
    } else {
      path.unshift("*");
    }
    const object: unknown = current.object;
    current = isNode(object) ? object : undefined;
  }
  return { path, computed };
}

/** The context's grouping objects: `ctx.d1`, `ctx.worker`, … */
const NAMESPACES: Set<string> = new Set(
  [...ACCESSORS.keys()].filter((accessor) => accessor.includes(".")).map((accessor) => accessor.split(".")[0]),
);

/** Matches the last one or two links, so renaming or destructuring `ctx` still resolves. */
function methodFor(path: string[]): string | undefined {
  if (path.length >= 2) {
    const pair = ACCESSORS.get(`${path[path.length - 2]}.${path[path.length - 1]}`);
    if (pair) return pair;
  }
  if (path.length >= 1) return ACCESSORS.get(path[path.length - 1]);
  return undefined;
}

function clip(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

/** `https://host:port` for a URL, so two paths on one host collapse into one row. */
function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "wss:" && url.protocol !== "ws:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** A literal address, or the literal head of one the script finishes at runtime. */
function addressOf(node: unknown): { origin: string; partial: boolean } | null {
  if (!isNode(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    const origin = originOf(node.value);
    return origin ? { origin, partial: false } : null;
  }
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis;
    if (!Array.isArray(quasis) || quasis.length === 0) return null;
    // A TemplateElement's `value` is a plain {raw, cooked} pair, not a node.
    const head = quasis[0] as Node | undefined;
    const value = isNode(head) ? (head.value as { cooked?: unknown } | undefined) : undefined;
    const cooked = value && typeof value === "object" ? value.cooked : undefined;
    if (typeof cooked !== "string") return null;
    const origin = originOf(cooked);
    // A one-piece template is just a string; more pieces mean the rest is built.
    return origin ? { origin, partial: quasis.length > 1 } : null;
  }
  return null;
}

export function scanRecipeScript(source: string): ScriptScan {
  const methods = new Set<string>();
  const network: NetworkTarget[] = [];
  const seen = new Set<string>();
  let opaqueNetwork = 0;
  let dynamicCode = false;
  let computedAccess = false;

  let program: Node;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Node;
  } catch (error) {
    return {
      parsed: false,
      parseError: clip(error instanceof Error ? error.message : String(error)),
      certain: false,
      methods,
      network,
      opaqueNetwork: 0,
      dynamicCode: false,
      computedAccess: false,
    };
  }

  const addTarget = (via: string, argument: unknown): void => {
    const address = addressOf(argument);
    if (!address) {
      opaqueNetwork += 1;
      return;
    }
    const key = `${via} ${address.origin} ${address.partial}`;
    if (seen.has(key) || network.length >= MAX_TARGETS) return;
    seen.add(key);
    network.push({ origin: clip(address.origin), via, partial: address.partial });
  };

  walk(program, (node) => {
    if (node.type === "ImportExpression") {
      dynamicCode = true;
      return;
    }

    // `const { provision } = ctx.d1` leaves a bare `provision()` behind, which
    // no accessor chain would resolve. The binding is where the name is still
    // attached to its namespace, so it is read here.
    if (node.type === "VariableDeclarator") {
      const init = node.init;
      const id = node.id;
      if (!isNode(init) || init.type !== "MemberExpression" || !isNode(id) || id.type !== "ObjectPattern") return;
      const namespace = accessorChain(init).path.slice(-1)[0] || "";
      if (!NAMESPACES.has(namespace)) return;
      const properties = Array.isArray(id.properties) ? id.properties : [];
      for (const property of properties) {
        if (!isNode(property) || property.type !== "Property" || !isNode(property.key)) continue;
        const key = property.key;
        const name =
          key.type === "Identifier"
            ? String(key.name)
            : key.type === "Literal" && typeof key.value === "string"
              ? key.value
              : "";
        const method = ACCESSORS.get(`${namespace}.${name}`);
        if (method) methods.add(method);
      }
      return;
    }

    if (node.type === "NewExpression") {
      const callee = node.callee;
      if (isNode(callee) && callee.type === "Identifier") {
        const name = String(callee.name);
        if (NETWORK_CONSTRUCTORS.has(name)) {
          const args = Array.isArray(node.arguments) ? node.arguments : [];
          addTarget(name, args[0]);
        }
        if (DYNAMIC_CODE_CALLS.has(name)) dynamicCode = true;
      }
      return;
    }

    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (!isNode(callee)) return;
    const args = Array.isArray(node.arguments) ? node.arguments : [];

    if (callee.type === "Identifier") {
      const name = String(callee.name);
      if (NETWORK_CALLS.has(name)) addTarget(name, args[0]);
      if (DYNAMIC_CODE_CALLS.has(name)) dynamicCode = true;
      return;
    }

    if (callee.type !== "MemberExpression") return;
    const { path, computed } = accessorChain(callee);
    if (computed) computedAccess = true;
    const dotted = path.join(".");
    const tail = path[path.length - 1] || "";

    const method = methodFor(path);
    if (method) methods.add(method);

    if (NETWORK_TAILS.has(dotted) || NETWORK_TAILS.has(tail)) addTarget("sendBeacon", args[0]);
    // XMLHttpRequest names its address in open(method, url), not the constructor.
    if (tail === "open" && args.length >= 2) {
      const address = addressOf(args[1]);
      if (address) addTarget("XMLHttpRequest", args[1]);
    }
    if (DYNAMIC_CODE_TAILS.has(dotted) || DYNAMIC_CODE_TAILS.has(tail)) dynamicCode = true;
  });

  return {
    parsed: true,
    certain: !dynamicCode && !computedAccess && opaqueNetwork === 0,
    methods,
    network,
    opaqueNetwork,
    dynamicCode,
    computedAccess,
  };
}
