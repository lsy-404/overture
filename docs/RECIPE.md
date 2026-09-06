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
  "schema": 2,
  "id": "edgesonic",
  "name": "EdgeSonic",
  "summary": { "en": "Subsonic-compatible music server on Workers", "zh-CN": "运行在 Workers 上的 Subsonic 兼容音乐服务" },
  "homepage": "https://github.com/lsy-404/edgesonic",
  "issues": { "url": "https://github.com/lsy-404/edgesonic/issues/new" },

  "version": "1.3.2",
  "tag": "v1.3.2",
  "buildTime": "2026-08-18T10:00:00Z",

  // The data package this configuration installs. `artifact` must be the fixed
  // name; the digest is checked against the bytes before anything is unpacked.
  "package": { "artifact": "overture.tar.gz", "sha256": "<64 hex chars>", "bytes": 3145728 },

  "license": { "id": "AGPL-3.0-or-later", "text": "                    GNU AFFERO GENERAL PUBLIC LICENSE\n…" },
  "terms": { "required": true, "texts": { "zh-CN": "…", "*": "…" } },

  // How this package can authenticate to Cloudflare. One mode is used per
  // deployment; it provides all the account authority the deploy needs.
  //   "oauth" — sign in with Cloudflare (best UX; no long-lived app credential).
  //             Only available when the operator has configured an OAuth client.
  //   "auto"  — the user creates a token against a pre-filled deep link (exactly
  //             the permissions below) and pastes it; it deploys and becomes the
  //             app's own credential. No token is minted or handled by the host
  //             beyond the deploy session.
  // Declare every mode the package supports. The wizard offers the intersection
  // of these and what this deployment can actually do (oauth needs the operator
  // to have set it up): it skips the chooser when only one is available, and
  // shows "not available here" when none are. A package that needs a cfApiToken
  // host secret (below) must offer "auto", since "oauth" cannot furnish an app a
  // long-lived credential.
  "authModes": ["auto"],

  // The authority table shown before any credential is asked for. `oauthScopes`
  // are Cloudflare OAuth scope names — dotted and lowercase, a different
  // namespace from the Title Case permission groups of classic API tokens — and
  // a row's scopes are all requested together, not alternatives. Every scope
  // must be one the deployment's OAuth client is registered to hold
  // (shared/oauthScopes.ts), or the whole configuration is rejected. An empty
  // list marks an authority OAuth cannot grant (the R2 S3 key pair), which the
  // wizard collects by hand. Only "required" rows block the deploy.
  "permissions": [
    { "key": "scripts", "requirement": "required", "oauthScopes": ["workers-scripts.write"],
      "scope": "account", "level": "write",
      "label": { "en": "Workers Scripts" }, "scenario": { "en": "Upload and deploy the Worker" } }
  ],

  // Read-only probes run before anything is provisioned. GET only, and the path
  // must be one the relay allow-lists. In Account API Token mode, Overture
  // derives and pre-fills the matching Read permission for every check. Set
  // `expect: "paid"` only on the subscriptions path to require an active Paid
  // account subscription; Trial, AwaitingPayment, Cancelled, Failed, and Expired
  // do not pass it.
  "checks": [
    { "id": "r2", "requirement": "required", "path": "/accounts/${accountId}/r2/buckets",
      "label": { "en": "R2 enabled" } },
    { "id": "paid", "requirement": "required", "path": "/accounts/${accountId}/subscriptions",
      "expect": "paid", "label": { "en": "Paid Cloudflare account" },
      "actionUrl": "https://dash.cloudflare.com/?to=/:account/billing" }
  ],

  // Storage the deployment needs. Overture renders a name field per entry, works
  // out whether the account already holds one, provisions it, and binds it.
  //
  // `match` is how a resource is recognised across renames and old versions.
  // Exact names are tried first, in the order given, and only then the patterns
  // (matched whole). Whatever it finds is named on the options page before
  // anything runs, and a pattern that matches more than one thing adopts none of
  // them — that choice goes to the user. Without `match`, only the name in the
  // field is looked for, so an upgrade that ever renamed anything deploys
  // against an empty resource and leaves the real one bound to nothing.
  "resources": [
    { "id": "db", "kind": "d1", "binding": "DB", "defaultName": "${worker}-db", "required": true,
      "match": { "names": ["${worker}-database", "edgesonic-db"], "patterns": ["^edgesonic-db-\\d+$"] },
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
    "durableObjects": [{ "binding": "ROOM_DO", "className": "RoomDO", "storage": "sqlite" }, { "binding": "STRONGHOLD_DO", "className": "StrongholdDO", "storage": "sqlite" }],
    "assetsRouting": { "notFoundHandling": "single-page-application", "runWorkerFirst": ["/api/*"] },
    "vars": [
      { "name": "INSTANCE_ID", "value": "${uuid}" },
      { "name": "R2_BUCKET_NAME", "value": "${resource:music}" }
    ],
    "containers": [{
      "className": "Sandbox",
      "mode": "ask",
      "image": { "reference": "docker.io/wuyilingwei/edgesonic@sha256:<64-hex-digest>" }
    }]
  },

  // Questions the wizard asks on the options page.
  "inputs": [
    { "id": "domain", "kind": "domain", "label": { "en": "Application domain" } },
    { "id": "admin_username", "kind": "text", "default": "admin", "label": { "en": "Administrator" } },
    { "id": "admin_password", "kind": "password", "generate": 12, "label": { "en": "Password" } }
  ],

  // What recipe.js is allowed to reach. Anything not listed does not exist for it.
  "capabilities": ["d1", "r2", "secrets", "worker", "assets", "cron", "domains", "turnstile", "probe"],

  // Workers Secrets whose value comes from Overture, not from recipe.js. The
  // review page states these plainly — an app keeping a copy of anything about
  // the deployment is something the user has to see before agreeing to it.
  // The deploy session credential itself cannot be named here: it never leaves
  // the deployment's own Worker, so there is nothing to hand over.
  //
  // `source` is one of: "accountId", "r2AccessKeyId", "r2SecretAccessKey", or
  // "cfApiToken". The last is the app's own long-lived Cloudflare token: it
  // carries `permissions`, each a Cloudflare token-template `{ key, type }` from
  // shared/cfTokenPermissions.ts (a key outside that table is rejected). In auto
  // mode the "create a token" deep link pre-fills exactly these and the package
  // name (which the user may edit), the user pastes the token, and it becomes
  // the app's credential — never the deploy session's.
  // A permission Cloudflare marks high-impact (token management, billing,
  // account governance) is flagged to the user before they agree.
  "hostSecrets": [
    { "name": "CF_ACCOUNT_ID", "source": "accountId", "requirement": "required",
      "reason": { "en": "Self-update and transcoding call the account's own API" } },
    { "name": "CF_API_TOKEN", "source": "cfApiToken", "requirement": "required", "placeholder": { "en": "cfat_…" },
      "permissions": [{ "key": "workers_scripts", "type": "edit" }, { "key": "workers_r2", "type": "edit" }],
      "reason": { "en": "The app manages its own cron and storage after deploy" } }
  ],

  // Turnstile widgets. The public sitekey and this configuration are always
  // available to recipe.js. A secret may be handed to recipe.js (high risk),
  // or written by the host to a named Worker Secret after recipe.js finishes.
  // Any package declaring this field must use only "auto" in authModes; the
  // account-token link adds the Turnstile permission automatically.
  "turnstiles": [
    { "id": "login", "name": "Login protection", "domains": ["${input:domain}"], "mode": "managed",
      "secret": { "target": "workerSecret", "name": "TURNSTILE_SECRET" } },
    { "id": "admin", "name": "Admin protection", "domains": ["admin.example.com"], "mode": "invisible",
      "secret": { "target": "recipe" } }
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

Cloudflare's OAuth Client permission picker does not provide Billing Read. In
Account API Token mode, Overture pre-fills Billing Read and verifies that the
subscriptions endpoint contains an exact `Paid` state. In OAuth mode, Overture
does not call that endpoint: it opens the account's Billing page and requires
the user to explicitly confirm the paid plan. That confirmation is shown as
user-confirmed, not automatically verified. A package that needs hard programmatic
enforcement must offer only `"auto"` for this pre-check.

### Conditional inputs

`placeholder` is an optional localized, non-secret format cue for a `text`,
`password`, or `domain` input (it is rejected on `toggle` and `select`). A
`cfApiToken` host secret may also declare it for the auto-token field (for
example, `cfat_…`). It is presentation-only: it is not validated as a prefix
and never becomes a credential value.

Use `onlyMode` to limit an input to a fresh or overwrite deployment. Use
`visibleWhen` when a field is meaningful only after another option is selected.
The predicate names a declared input and compares its scalar value exactly.
Its optional `mode` applies that predicate only in one deployment mode; this
keeps initial credentials visible for a fresh deployment while requiring an
explicit reset choice during an overwrite. Hidden fields are neither validated
as required nor sent to `recipe.js`.

For an application-generated password, do not mark the password input
`required`: an empty value reaches `recipe.js`, which must generate the value,
use it for the deployment, and return it once with
`ctx.result({ credentials: [{ label: "Password", value, secret: true }] })`.
The completion page is the only Overture UI that displays such credentials and
keeps them in current-page memory only.

```json
[
  { "id": "reset_admin", "kind": "toggle", "onlyMode": "overwrite", "label": { "en": "Reset administrator" } },
  { "id": "admin_username", "kind": "text",
    "visibleWhen": { "input": "reset_admin", "equals": true, "mode": "overwrite" }, "label": { "en": "Administrator username" } },
  { "id": "admin_password", "kind": "password", "generate": 16,
    "visibleWhen": { "input": "reset_admin", "equals": true, "mode": "overwrite" }, "label": { "en": "Administrator password" } }
]
```

### Interpolation

`${worker}`, `${version}`, `${buildTime}`, `${tag}`, `${uuid}`, `${accountId}`, `${resource:<id>}`,
`${input:<id>}`, and — on done-page links only — `${url}`. Anything else is left as written.

`${uuid}` is generated once per deployment, so two vars using it get the same value.

When an overwrite must retain a declared plain-text variable, call
`ctx.worker.uploadVersion({ preserveLiveVars: ["VAR_NAME"] })`. The host reads the
value from its pre-deploy snapshot and ignores names that the recipe did not declare;
the recipe never supplies the retained value.

### Container images

`worker.containers[].image.reference` is a fully-qualified public Docker Hub image pinned as `docker.io/owner/repository@sha256:<64-hex-digest>`. Mutable tags are rejected. The wizard has no image URL field, never receives registry credentials, and never passes the reference to `recipe.js`. When a user chooses **on**, Overture activates the Worker version first, then asks Cloudflare Containers to pull that declared image and create or roll out the derived application `${worker}-${className}` (lowercase). **Unchanged** performs no Container application or rollout call; **off** omits the class from the Worker version.

Cloudflare performs this sequence non-transactionally: a later image-pull or rollout failure does not undo the Worker traffic switch. Package authors must keep the Worker and image compatible during the rollout window.

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
  const turnstile = await ctx.turnstile.provision("login");
  // `secret` exists only when this widget declares { "target": "recipe" }.
  // A { "target": "workerSecret", "name": "…" } secret is written by the
  // host after this recipe finishes and is never returned here.
  const assets = await ctx.assets.upload();
  const { versionId } = await ctx.worker.uploadVersion({
    assets,
    extraVars: { TURNSTILE_SITE_KEY: turnstile.sitekey },
  });
  await ctx.worker.switchTraffic(versionId);
  await ctx.step("upload", "success");

  await ctx.result({ notes: ["Deployed"] });
}
```

The full context surface is `RecipeContext` in `src/lib/sandbox/protocol.ts`.

### What the script can and cannot do

It runs in an `<iframe sandbox="allow-scripts">`: an opaque origin with no access to the wizard's DOM,
storage or variables. It cannot read the Cloudflare credential (which never reaches the page at all), the R2 key pair, or any host state — the
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
declared capabilities reach and the permissions those need, every `checks` path that is not an
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

Packages should declare `issues.url`: an HTTPS URL to their public issue-creation page. After a failed
deployment, Overture offers to open that URL with a prefilled report. Existing packages without this
field remain deployable but do not show the reporting action. The report contains only the package id,
package version, declared failed step, and a generic failure summary. It deliberately does not include
error text, credentials, account IDs, input values, resource names, or any other deployment
configuration.
