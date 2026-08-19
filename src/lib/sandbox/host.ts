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

// The host half of the capability bridge: it owns the frame, decides which
// calls exist, and enforces the budgets. Everything a call actually *does*
// lives in ../engine/capabilities.ts — this file only decides whether the call
// is allowed to get there.

import type { Capability, Recipe } from "../recipe/types";
import {
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL,
  METHOD_GATES,
  type GuestCallMessage,
  type GuestContext,
  type GuestMessage,
  type HostReplyMessage,
  type HostStartMessage,
} from "./protocol";
import { GUEST_BOOTSTRAP } from "./guest";

/**
 * `connect-src https:` is deliberate: a recipe may fetch its own CORS-enabled
 * resources. No credential is in this frame, so what it can reach is not a
 * disclosure surface — and `default-src 'none'` keeps everything else out.
 *
 * What it may not do is turn any of those bytes into code. There is no
 * `'unsafe-inline'`, so a fetched string cannot be appended as a script element;
 * no `'unsafe-eval'`, so `eval`, `new Function` and WebAssembly are out; and no
 * remote scheme, so a module cannot be imported from a URL. The bootstrap runs
 * because its own hash is named here. `blob:` is here for exactly one import —
 * the package's own recipe.js — and the bootstrap removes the only function
 * that can mint a Blob URL as soon as it has used it. The code that runs in this
 * frame is the code the user was shown, and nothing else.
 *
 * The allowance is a hash and not a nonce on purpose, and the browser probe in
 * test/fixtures is what found the difference: a nonce is inherited down a module
 * graph, so the bootstrap's nonce would pass to the recipe module and from there
 * to whatever that module chose to import — `import("https://…")` loads. A hash
 * authorises one script and nothing downstream of it.
 */
function frameCsp(hash: string): string {
  return `default-src 'none'; script-src 'sha256-${hash}' blob:; connect-src https:`;
}

async function bootstrapHash(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(GUEST_BOOTSTRAP));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface SandboxInput {
  /** Only its `capabilities` are consulted here; the guest gets the whole recipe. */
  recipe: Recipe;
  context: GuestContext;
  /** Source text of the package's recipe.js. */
  script: string;
  /** Runs an already-permitted call. Its rejections are shown to the recipe verbatim. */
  invoke: (method: string, args: unknown[], signal?: AbortSignal) => Promise<unknown>;
}

export interface SandboxOutcome {
  ok: boolean;
  /** Failure text, safe to show the user. */
  message?: string;
  /** Step the recipe was inside when it failed, when it said. */
  step?: string;
}

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Rough size of one call's arguments. Rough is enough — this exists to stop a
 * recipe from handing over a gigabyte, not to bill it precisely. Cyclic and
 * absurdly wide structures answer "over budget" rather than hanging.
 */
function payloadBytes(value: unknown, limit: number): number {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  let total = 0;
  let nodes = 0;
  while (stack.length > 0) {
    if (++nodes > 200000) return limit + 1;
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === "string") total += current.length * 2;
    else if (typeof current === "number" || typeof current === "boolean" || typeof current === "bigint") total += 8;
    else if (typeof current === "object") {
      const node = current as object;
      if (seen.has(node)) continue;
      seen.add(node);
      if (node instanceof ArrayBuffer) total += node.byteLength;
      else if (ArrayBuffer.isView(node)) total += node.byteLength;
      else if (node instanceof Blob) total += node.size;
      else if (Array.isArray(node)) for (const item of node) stack.push(item);
      else if (node instanceof Map) for (const [key, item] of node as Map<unknown, unknown>) stack.push(key, item);
      else if (node instanceof Set) for (const item of node as Set<unknown>) stack.push(item);
      else {
        for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
          total += key.length * 2;
          stack.push(item);
        }
      }
    }
    if (total > limit) return total;
  }
  return total;
}

async function frameHtml(): Promise<string> {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(await bootstrapHash())}">` +
    // Split so this string cannot close the script element it ends up inside.
    `</head><body><script>${GUEST_BOOTSTRAP}</scr` +
    "ipt></body></html>"
  );
}

/**
 * Runs a package's recipe.js to completion in a throwaway sandbox frame.
 * Resolves — never rejects — with what happened; the frame, the listener and
 * every timer are gone by then either way.
 */
export async function runSandbox(input: SandboxInput): Promise<SandboxOutcome> {
  // Computed before the frame exists: the policy names the bootstrap's hash, so
  // the two cannot be assembled out of order.
  const html = await frameHtml();
  return new Promise<SandboxOutcome>((resolve) => {
    const granted = new Set<Capability>(input.recipe.capabilities || []);
    const timers = new Set<number>();
    let settled = false;
    let started = false;
    let calls = 0;
    let privilegedCalls = 0;
    let readyTimer = 0;
    let privilegedQueue: Promise<unknown> = Promise.resolve();

    const controller = new AbortController();

    const frame = document.createElement("iframe");
    // No allow-same-origin: with it the frame would share this document's
    // origin and could read the API token straight out of sessionStorage.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", "recipe sandbox");
    // Off-screen and zero-sized rather than `hidden`/`display:none`, which
    // invite renderer throttling of a frame that has real work to do.
    frame.style.cssText = "position:fixed;left:-9999px;top:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
    frame.srcdoc = html;

    const after = (ms: number, run: () => void): number => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
      return timer;
    };

    const finish = (outcome: SandboxOutcome): void => {
      if (settled) return;
      settled = true;
      controller.abort();
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(outcome);
    };

    const post = (message: HostStartMessage | HostReplyMessage): boolean => {
      const target = frame.contentWindow;
      if (settled || !target) return false;
      try {
        // "*" is the only usable target for an opaque origin. Nothing secret
        // travels this way: the start context and every reply are host-picked.
        target.postMessage(message, "*");
        return true;
      } catch {
        return false;
      }
    };

    const reply = (id: number, ok: boolean, value?: unknown, message?: string): void => {
      const payload: HostReplyMessage = ok ? { kind: "reply", id, ok: true, value } : { kind: "reply", id, ok: false, message: clip(message || "the capability call failed", BRIDGE_LIMITS.maxErrorChars) };
      if (post(payload)) return;
      // A value that cannot be cloned would strand the recipe on a promise
      // that never settles, so say so instead of leaving it hanging.
      if (ok) post({ kind: "reply", id, ok: false, message: "the capability result could not be delivered" });
    };

    const callTimeout = <T,>(work: Promise<T>): Promise<T> =>
      new Promise<T>((done, fail) => {
        const timer = after(BRIDGE_LIMITS.callTimeoutMs, () => fail(new Error("the capability call timed out")));
        work.then(
          (value) => {
            window.clearTimeout(timer);
            timers.delete(timer);
            done(value);
          },
          (error: unknown) => {
            window.clearTimeout(timer);
            timers.delete(timer);
            fail(error);
          },
        );
      });

    const handleCall = async (message: GuestCallMessage): Promise<void> => {
      const id = typeof message.id === "number" ? message.id : 0;
      const method = typeof message.method === "string" ? message.method : "";
      const args = Array.isArray(message.args) ? message.args : [];

      if (++calls > BRIDGE_LIMITS.maxCalls) {
        finish({ ok: false, message: "the recipe made more capability calls than its budget allows" });
        return;
      }

      // Two exact-match gates, never a prefix: the method has to be one this
      // protocol defines, and its capability has to be one recipe.json asked
      // for and the review page therefore showed the user.
      if (!Object.prototype.hasOwnProperty.call(METHOD_GATES, method)) {
        reply(id, false, undefined, `unknown capability method: ${clip(method, 60)}`);
        return;
      }
      const gate = METHOD_GATES[method];
      if (gate !== null) {
        if (!granted.has(gate)) {
          reply(id, false, undefined, `recipe.json does not declare the "${gate}" capability, so ${method} is unavailable`);
          return;
        }
        if (++privilegedCalls > BRIDGE_LIMITS.maxPrivilegedCalls) {
          finish({ ok: false, message: "the recipe made more Cloudflare calls than its budget allows" });
          return;
        }
      }

      if (payloadBytes(args, BRIDGE_LIMITS.maxCallBytes) > BRIDGE_LIMITS.maxCallBytes) {
        finish({ ok: false, message: `a ${method} call exceeded the ${BRIDGE_LIMITS.maxCallBytes}-byte argument budget` });
        return;
      }

      if (gate === null) {
        try {
          reply(id, true, await callTimeout(input.invoke(method, args, controller.signal)));
        } catch (error) {
          reply(id, false, undefined, error instanceof Error ? error.message : String(error));
        }
        return;
      }

      // Cloudflare-bound calls run one at a time, in the order the recipe made
      // them — a queued promise chain, not a new dependency. Each link swallows
      // its own rejection so one failed call never wedges the calls behind it.
      const run = (): Promise<unknown> => callTimeout(input.invoke(method, args, controller.signal));
      const settledRun = privilegedQueue.then(run, run);
      privilegedQueue = settledRun.then(
        () => undefined,
        () => undefined,
      );
      try {
        reply(id, true, await settledRun);
      } catch (error) {
        reply(id, false, undefined, error instanceof Error ? error.message : String(error));
      }
    };

    function onMessage(event: MessageEvent): void {
      if (settled) return;
      // Frame identity, not origin — an opaque origin is "null" for every
      // sandboxed frame on the page, so origin proves nothing here.
      if (!frame.contentWindow || event.source !== frame.contentWindow) return;
      const data = event.data as GuestMessage | null;
      if (!data || typeof data !== "object") return;
      switch (data.kind) {
        case "ready":
          // One start per frame: a second `ready` would only buy the recipe
          // another run timer.
          if (started) return;
          started = true;
          window.clearTimeout(readyTimer);
          timers.delete(readyTimer);
          if (data.protocol !== BRIDGE_PROTOCOL) {
            finish({ ok: false, message: `the sandbox answered with bridge protocol ${String(data.protocol)}, expected ${BRIDGE_PROTOCOL}` });
            return;
          }
          if (!post({ kind: "start", protocol: BRIDGE_PROTOCOL, context: input.context, script: input.script })) {
            finish({ ok: false, message: "the recipe sandbox could not be started" });
            return;
          }
          after(BRIDGE_LIMITS.runTimeoutMs, () => finish({ ok: false, message: "the recipe ran past its time budget" }));
          return;
        case "call":
          void handleCall(data);
          return;
        case "finished":
          finish({ ok: true });
          return;
        case "failed":
          finish({
            ok: false,
            message: clip(typeof data.message === "string" ? data.message : "the recipe failed", BRIDGE_LIMITS.maxErrorChars),
            step: typeof data.step === "string" ? data.step : undefined,
          });
          return;
        default:
          return;
      }
    }

    window.addEventListener("message", onMessage);
    document.body.appendChild(frame);
    readyTimer = after(BRIDGE_LIMITS.readyTimeoutMs, () => finish({ ok: false, message: "the recipe sandbox never reported ready" }));
  });
}
