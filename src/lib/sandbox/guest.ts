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

// The script that runs inside the sandbox frame, shipped as source text rather
// than as a module of this app: the frame has an opaque origin and loads
// nothing over the network, so the only way in is host.ts inlining this string
// into the frame's own HTML.
//
// It turns each method of RecipeContext into "post a call, await the reply",
// which is why a recipe can await `ctx.d1.provision(...)` without knowing that
// the work happens in another frame it cannot see.

import { BRIDGE_PROTOCOL } from "./protocol";

export const GUEST_BOOTSTRAP = `
(function () {
  "use strict";

  var pending = new Map();
  var nextCallId = 1;
  var currentStep = "";
  var started = false;

  function post(message) {
    parent.postMessage(message, "*");
  }

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = nextCallId++;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ kind: "call", id: id, method: method, args: args });
    });
  }

  function settle(reply) {
    var entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply.value);
    else entry.reject(new Error(String(reply.message || "the capability call failed")));
  }

  // The recipe reaches the world only through these; anything not listed here
  // it simply does not have.
  function contextFor(shared) {
    return {
      ctx: shared,

      step: function (id, status, detail) {
        // Remembered so a throw can be attributed to the line the user is
        // watching, without the recipe having to say which one it was.
        if (status === "running") currentStep = String(id);
        return call("step.set", [id, status, detail]);
      },
      progress: function (id, fraction) {
        return call("step.progress", [id, fraction]);
      },
      result: function (patch) {
        return call("result.set", [patch]);
      },

      file: function (path) {
        return call("pkg.file", [path]);
      },
      text: function (path) {
        return call("pkg.text", [path]);
      },

      d1: {
        provision: function (resourceId) {
          return call("d1.provision", [resourceId]);
        },
        query: function (resourceId, sql, params) {
          return call("d1.query", [resourceId, sql, params]);
        },
      },
      r2: {
        provision: function (resourceId) {
          return call("r2.provision", [resourceId]);
        },
      },
      kv: {
        provision: function (resourceId) {
          return call("kv.provision", [resourceId]);
        },
      },
      secrets: {
        put: function (name, value) {
          return call("secrets.put", [name, value]);
        },
        putHostValue: function (name) {
          return call("secrets.putHostValue", [name]);
        },
      },
      worker: {
        deleteScript: function () {
          return call("worker.deleteScript", []);
        },
        uploadVersion: function (options) {
          return call("worker.uploadVersion", [options]);
        },
        switchTraffic: function (versionId) {
          return call("worker.switchTraffic", [versionId]);
        },
      },
      assets: {
        upload: function () {
          return call("assets.upload", []);
        },
      },
      cron: {
        read: function () {
          return call("cron.read", []);
        },
        set: function (crons) {
          return call("cron.set", [crons]);
        },
      },
      domains: {
        list: function () {
          return call("domains.list", []);
        },
        attach: function (hostname) {
          return call("domains.attach", [hostname]);
        },
      },
      probe: {
        reachable: function (url) {
          return call("probe.reachable", [url]);
        },
      },
      crypto: {
        sha256Hex: function (value) {
          return call("crypto.sha256Hex", [value]);
        },
        password: function (length) {
          return call("crypto.password", [length]);
        },
        randomBase64: function (bytes) {
          return call("crypto.randomBase64", [bytes]);
        },
        uuid: function () {
          return call("crypto.uuid", []);
        },
      },
    };
  }

  // A Blob URL is the only module specifier an opaque origin can resolve, and
  // the frame's CSP allows exactly that one scheme for scripts.
  function load(source) {
    var url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return import(url).finally(function () {
      URL.revokeObjectURL(url);
    });
  }

  async function start(message) {
    if (started) return;
    started = true;
    try {
      var module = await load(message.script);
      var deploy = module ? module.deploy : null;
      if (typeof deploy !== "function") throw new Error("recipe.js must export a deploy(ctx) function");
      await deploy(contextFor(message.context));
      post({ kind: "finished" });
    } catch (error) {
      var text = (error && error.message) || String(error);
      post({ kind: "failed", message: String(text), step: currentStep || undefined });
    }
  }

  // Identity, not origin: an opaque origin reports itself as "null", which any
  // other sandboxed frame could also claim.
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.kind === "reply") settle(data);
    else if (data.kind === "start") start(data);
  });

  post({ kind: "ready", protocol: ${BRIDGE_PROTOCOL} });
})();
`;
