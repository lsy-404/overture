# Deploy package format

Overture deploys whatever a release tells it to deploy. To become deployable, a repository publishes
two fixed-name assets on a GitHub release:

| Asset | What it is |
|---|---|
| `overture.tar.gz` | the deploy package (gzipped tar, ≤ 24 MiB) |
| `overture-manifest.json` | integrity and version header for that package |

Nothing else about the repository matters. Overture reads only these two assets.

## `overture-manifest.json`

```json
{
  "schema": 1,
  "tag": "v1.3.2",
  "version": "1.3.2",
  "buildTime": "2026-08-18T10:00:00Z",
  "artifact": "overture.tar.gz",
  "artifactSha256": "<64 hex chars>"
}
```

`artifact` must be exactly `overture.tar.gz`, and the digest must match the asset — Overture refuses a
package whose bytes disagree with the manifest, and refuses a manifest whose `version` disagrees with
the release tag.

## Inside the package

```
recipe.json            required — static metadata (below)
recipe.js              required — ESM module exporting deploy(ctx)
LICENSE                the licence text recipe.json points at
terms/zh-CN.md         terms of service, per locale, optional
worker/index.js        the Worker's ESM entry
assets-manifest.json   Cloudflare asset manifest, if the app ships static assets
assets/**              those assets, plus an optional assets/_headers
migrations/*.sql       whatever SQL recipe.js runs
```

Paths are package-relative and may not escape the package. Only `recipe.json` and `recipe.js` have
fixed names; everything else is named by `recipe.json`.

## `recipe.json`

The full type is `src/lib/recipe/types.ts` — that file is normative, this section is the tour.

```jsonc
{
  "schema": 1,
  "id": "edgesonic",
  "name": "EdgeSonic",
  "summary": { "en": "Subsonic-compatible music server on Workers", "zh-CN": "运行在 Workers 上的 Subsonic 兼容音乐服务" },
  "homepage": "https://github.com/wuyilingwei/edgesonic",
  "version": "1.3.2",

  "license": { "id": "AGPL-3.0-or-later", "file": "LICENSE" },
  "terms": { "files": { "zh-CN": "terms/zh-CN.md", "*": "terms/en.md" }, "required": true },

  // Drives the API Token table on the credentials page. Holding any one group
  // in `groups` satisfies the row. Only "required" rows block the deploy.
  "permissions": [
    { "key": "scripts", "requirement": "required", "groups": ["Workers Scripts Write", "Workers Scripts Edit"],
      "scope": "account", "level": "write",
      "label": { "en": "Workers Scripts" }, "scenario": { "en": "Upload and deploy the Worker" } }
  ],

  // Read-only probes run before anything is provisioned. GET only, and the path
  // must be one the relay allow-lists.
  "checks": [
    { "id": "r2", "requirement": "required", "path": "/accounts/${accountId}/r2/buckets",
      "label": { "en": "R2 enabled" } }
  ],

  // Storage the deployment needs. Overture renders a name field per entry,
  // warns when the name already exists, provisions it, and binds it.
  "resources": [
    { "id": "db", "kind": "d1", "binding": "DB", "defaultName": "${worker}-db", "required": true,
      "label": { "en": "Library database" } },
    { "id": "music", "kind": "r2", "binding": "MUSIC_BUCKET", "defaultName": "${worker}-storage",
      "required": true, "s3Keys": "optional", "label": { "en": "Music storage" } }
  ],

  "worker": {
    "defaultName": "edgesonic",
    "module": "worker/index.js",
    "assetsManifest": "assets-manifest.json",
    "assetsDir": "assets",
    "assetHeaders": "assets/_headers",
    "compatibilityDate": "2025-05-24",
    "compatibilityFlags": ["nodejs_compat"],
    "vars": [
      { "name": "INSTANCE_ID", "value": "${uuid}" },
      { "name": "R2_BUCKET_NAME", "value": "${resource:music}" }
    ],
    "containers": [{ "className": "Sandbox", "mode": "ask" }]
  },

  // Questions the wizard asks on the options page.
  "inputs": [
    { "id": "adminUsername", "kind": "text", "default": "admin", "label": { "en": "Administrator" } },
    { "id": "adminPassword", "kind": "password", "generate": 12, "label": { "en": "Password" } }
  ],

  // What recipe.js is allowed to reach. Anything not listed does not exist for it.
  "capabilities": ["d1", "r2", "secrets", "worker", "assets", "cron", "domains", "probe"],

  // Workers Secrets whose value comes from Overture, not from recipe.js. The
  // review page states these plainly — an app receiving the deploying account's
  // API token is something the user has to see before agreeing to it.
  "hostSecrets": [
    { "name": "CF_ACCOUNT_ID", "source": "accountId", "requirement": "required",
      "reason": { "en": "Self-update and transcoding call the account's own API" } }
  ],

  // The execution checklist. recipe.js drives the transitions.
  "steps": [
    { "id": "storage", "label": { "en": "Provision storage" } },
    { "id": "schema", "label": { "en": "Apply database schema" } },
    { "id": "upload", "label": { "en": "Upload Worker" }, "weight": 3 }
  ],

  "health": { "path": "/edgesonic/version" },
  "done": { "links": [{ "label": { "en": "Open the app" }, "href": "${url}" }] }
}
```

### Interpolation

`${worker}`, `${version}`, `${buildTime}`, `${tag}`, `${uuid}`, `${accountId}`, `${resource:<id>}`,
`${input:<id>}`, and — on done-page links only — `${url}`. Anything else is left as written.

`${uuid}` is generated once per deployment, so two vars using it get the same value.

## `recipe.js`

```js
export async function deploy(ctx) {
  await ctx.step("storage", "running");
  const { databaseId } = await ctx.d1.provision("db");   // eslint-disable-line no-unused-vars
  await ctx.r2.provision("music");
  await ctx.step("storage", "success");

  await ctx.step("schema", "running");
  await ctx.d1.query("db", await ctx.text("migrations/Schema.sql"));
  await ctx.step("schema", "success");

  await ctx.step("upload", "running");
  const assets = await ctx.assets.upload();
  const { versionId } = await ctx.worker.uploadVersion({ assets });
  await ctx.worker.switchTraffic(versionId);
  await ctx.step("upload", "success");

  await ctx.result({ notes: ["Deployed"] });
}
```

The full context surface is `RecipeContext` in `src/lib/sandbox/protocol.ts`.

### What the script can and cannot do

It runs in an `<iframe sandbox="allow-scripts">`: an opaque origin with no access to the wizard's DOM,
storage or variables. It cannot read the Cloudflare API token, the R2 key pair, or any host state — the
only things it receives are its own `recipe.json`, the names and choices the user made, and facts about
the live Worker (`ctx.ctx.live`).

Bindings are built by the host from `recipe.json`, not by the script, so a script cannot bind a
resource its recipe never declared. Undeclared capabilities are rejected. Calls are budgeted and timed
out (`BRIDGE_LIMITS`).

What a script *can* do is everything its declared capabilities allow inside the deploying account —
which is why the operator's policy page keeps a source allowlist, enabled by default.

### Failure

Throw. The message reaches the user attached to whichever step was last set `running`. For a step the
recipe legitimately skips, report `skipped` rather than throwing.
