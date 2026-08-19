# Deploy package format

Overture deploys whatever a release tells it to deploy. To become deployable, a repository publishes
two fixed-name assets on a GitHub release:

| Asset | What it is | Size |
|---|---|---|
| `overture.json` | the **install configuration** — everything the wizard needs to ask the user anything | kilobytes |
| `overture.tar.gz` | the **install data package** — the bytes that get deployed | up to 24 MiB |

They are separate on purpose. The wizard fetches the configuration as soon as a version is picked, and
renders the terms, the licence, the permission table and the resource-naming form off it alone. The data
package is only fetched once the user presses deploy, as the first line of the execution checklist.

Nothing else about the repository matters. Overture reads only these two assets.

## `overture.json` — install configuration

The full type is `src/lib/recipe/types.ts` — that file is normative, this section is the tour. The
licence and terms text are inline here rather than in the package, because they have to be readable
before anything is downloaded.

```jsonc
{
  "schema": 1,
  "id": "edgesonic",
  "name": "EdgeSonic",
  "summary": { "en": "Subsonic-compatible music server on Workers", "zh-CN": "运行在 Workers 上的 Subsonic 兼容音乐服务" },
  "homepage": "https://github.com/wuyilingwei/edgesonic",

  "version": "1.3.2",
  "tag": "v1.3.2",
  "buildTime": "2026-08-18T10:00:00Z",

  // The data package this configuration installs. `artifact` must be the fixed
  // name; the digest is checked against the bytes before anything is unpacked.
  "package": { "artifact": "overture.tar.gz", "sha256": "<64 hex chars>", "bytes": 3145728 },

  "license": { "id": "AGPL-3.0-or-later", "text": "                    GNU AFFERO GENERAL PUBLIC LICENSE\n…" },
  "terms": { "required": true, "texts": { "zh-CN": "…", "*": "…" } },

  // Drives the API Token table on the credentials page. Holding any one group
  // in `groups` satisfies the row. Only "required" rows block the deploy.
  // Use the API spelling: a token's own policies read back as "Write", and
  // "Edit" is only what the dashboard prints on the same checkbox.
  "permissions": [
    { "key": "scripts", "requirement": "required", "groups": ["Workers Scripts Write"],
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

  // Paths here are resolved inside the data package, at deploy time.
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

  // The execution checklist. recipe.js drives the transitions. Overture prepends
  // its own line for fetching the package, and appends one for the health probe.
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

## `overture.tar.gz` — install data package

```
recipe.js              required — ESM module exporting deploy(ctx)
worker/index.js        the Worker's ESM entry
assets-manifest.json   Cloudflare asset manifest, if the app ships static assets
assets/**              those assets, plus an optional assets/_headers
migrations/*.sql       whatever SQL recipe.js runs
```

`recipe.js` is the only fixed name; everything else is named by `overture.json`. Paths are
package-relative and may not escape the package. The archive's digest must match `package.sha256`.

## `recipe.js`

```js
export async function deploy(ctx) {
  await ctx.step("storage", "running");
  await ctx.d1.provision("db");
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
only things it receives are its own configuration, the names and choices the user made, and facts about
the live Worker (`ctx.ctx.live`).

Bindings are built by the host from `overture.json`, not by the script, so a script cannot bind a
resource its configuration never declared. Undeclared capabilities are rejected. Calls are budgeted and
timed out (`BRIDGE_LIMITS`).

What a script *can* do is everything its declared capabilities allow inside the deploying account —
which is why the operator's policy page keeps a source allowlist, enabled by default.

The frame's CSP allows outbound `https` requests, so a script may fetch its own CORS-enabled resources.
Nothing it can reach carries a credential, but anything it has computed can leave that way.

What it may not do is *run* any of it. The frame executes the bootstrap (allowed by its own hash) and
the package's `recipe.js` (imported from the one Blob URL the bootstrap mints before removing
`URL.createObjectURL`), and nothing else: no `eval`, no `new Function`, no WebAssembly, no
`import("https://…")`, no script element appended at run time. A package ships the code it runs. If your
recipe needs a library, bundle it into `recipe.js` — fetching one at deploy time will throw.

### The package is read before it runs

Once a release is picked, Overture fetches the data package, checks its digest, and reads `recipe.js`
without executing it. The user is shown, before being asked for anything: the Cloudflare endpoints the
declared capabilities reach and the token permissions those need, every `checks` path that is not an
endpoint the relay will forward, every address the script contacts on its own, and every disagreement
between what `overture.json` declares and what the script is written to call.

Two things follow for a package author. Declare the capabilities the script actually uses and no more —
a capability that is declared and never called is shown as such, and one that is called but not declared
is shown as a call that will be refused mid-deployment. And keep the script readable: `eval`, a computed
method name, or a URL assembled at run time all make the report say that this package hides part of what
it does, which is what a reader will act on.

### There is no log

A recipe cannot narrate. There is no `ctx.log`, and Overture writes no deployment record anywhere — it
is a public deployer working inside strangers' accounts, and keeping a trail of who installed what is
not its business. The step checklist is live UI state in the user's own browser and is gone when the tab
closes.

### Failure

Throw. The message reaches the user attached to whichever step was last set `running`, truncated to
`BRIDGE_LIMITS.maxErrorChars`. For a step the recipe legitimately skips, report `skipped` rather than
throwing. Make the message say what to fix — it is the only diagnostic anyone will get.
