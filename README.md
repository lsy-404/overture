# Overture

[English](README.md) | [简体中文](README.zh-CN.md)

A universal Cloudflare Workers deployment wizard that runs entirely in your browser. Deploy any GitHub release to Cloudflare Workers by signing in with your Cloudflare account — no local toolchain, no Node.js, no command line.

## How to use it

1. Visit `https://<your-overture-host>/?src=<owner>/<repo>` (replace `<owner>/<repo>` with the GitHub repository).
2. Review what the package will do: the permissions it needs, the endpoints it reaches, and the resources it creates.
3. Sign in with Cloudflare when prompted — the wizard requests only the permissions this package declares.
4. Name your resources and confirm. Overture provisions everything: D1 databases, R2 buckets, KV namespaces, and the Worker itself.

The wizard shows progress step by step. A failed deployment can be retried, and anything already created is reused rather than duplicated.

## For app developers: make your project deployable

To make your GitHub repository deployable via Overture, publish two assets with each release:

| Asset | Contents |
|-------|----------|
| `overture.json` | Install config: metadata, inlined license/terms text, permissions, declared D1/R2/KV resources, step list, and the SHA-256 of the data package |
| `overture.tar.gz` | Install data package: `recipe.js`, Worker modules, assets, and SQL — the bytes that actually run |

`overture.json` is small (KB-scale) and readable before anything is downloaded, so the wizard can show licenses, terms, and permissions up front. `overture.tar.gz` holds only what the recipe needs to execute.

Packages may declare Turnstile widgets in `turnstiles[]`. Overture always gives the widget's public sitekey and configuration to `recipe.js`. A Turnstile secret can either be handed to `recipe.js` explicitly (`secret.target: "recipe"`, which the confirmation page flags as high risk) or written by Overture to a named Worker Secret after the recipe completes (`secret.target: "workerSecret"`). Packages using Turnstile must use only Account API Token (`auto`) authentication; the token creation link includes the Turnstile permission automatically.

The full specification is in [`docs/RECIPE.md`](docs/RECIPE.md). See the [EdgeSonic repository](https://github.com/wuyilingwei/edgesonic) for a complete reference implementation.

## For operators: self-host Overture

Overture itself is a Cloudflare Worker. To run your own:

### Prerequisites

- A Cloudflare account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) for deployment
- Node.js 20+

### Setup

1. Clone this repository.

2. Copy the example configuration:
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```
   Edit `wrangler.toml` and fill in your `account_id`.

   Set `ALLOWED_ORIGINS` to the origin(s) your Overture instance is served from, and, if you want to restrict which repositories can be deployed, set `ALLOWLIST_ENABLED = true` and list the allowed `owner/repo` entries in `ALLOWED_SOURCES`.

3. Deploy:
   ```bash
   npm install
   npm run build
   npx wrangler deploy
   ```

Nothing else to configure — no secrets to set, no namespaces to create. The Worker holds no persistent storage; the deployment policy is whatever `ALLOWLIST_ENABLED` / `ALLOWED_SOURCES` say in `wrangler.toml` at deploy time.

## Security model

Overture is designed to minimize the blast radius of a compromised package:

- **Credentials stay with you.** The sign-in token Cloudflare issues lives in an encrypted, HttpOnly cookie that only your own Overture deployment can read — page scripts, the recipe sandbox, logs, and URLs never see it, and nothing is stored server-side. Any R2 keys you enter stay in this browser tab.

- **Recipe runs in a sandboxed iframe.** Each `recipe.js` runs in an opaque-origin iframe with `sandbox="allow-scripts"` — no DOM access, no same-origin policy, no local storage. It cannot read your credentials or interfere with the wizard's UI.

- **Capabilities are gated.** The recipe can only call capabilities it declares (D1, R2, Workers, etc.), and every Cloudflare API path the relay touches is hardcoded and validated — no wildcards or prefix matching.

- **Relay allowlist blocks bad actors.** The Worker relay enforces a strict allowlist of Cloudflare API paths. Paths not on the list are rejected outright, even if the recipe requests them.

- **No logging, no persistence.** Overture writes no logs and keeps no deployment records — the only diagnostic is an error message tied to the step that failed, truncated in length, and it exists only in your own browser's memory. The Worker has no database or KV of its own.

- **Deployment policy is read-only.** The policy page shows the allowlist currently in effect, computed from `ALLOWLIST_ENABLED` / `ALLOWED_SOURCES` in `wrangler.toml`. There is no login and no in-app editor — an operator changes policy by editing those vars and redeploying.

That said, **a whitelisted package can still do whatever its recipe declares within your Cloudflare account** — provision resources, run D1 queries, upload Workers, etc. Only put repositories you control or have thoroughly reviewed on the allowlist. The allowlist is a guardrail, not a sandbox.

## Documentation

| Document | For |
|----------|-----|
| [`docs/RECIPE.md`](docs/RECIPE.md) | App developers: complete specification for `recipe.json` and `recipe.js` |
| [`src/lib/recipe/types.ts`](src/lib/recipe/types.ts) | TypeScript reference for the recipe format |
| [`src/lib/sandbox/protocol.ts`](src/lib/sandbox/protocol.ts) | Recipe script capabilities and API limits |

## Licence

[AGPL-3.0-or-later](LICENSE)

The browser UI uses components from [WinUIonWeb](https://github.com/Furry-Xiyi/WinUIonWeb) (GPL-3.0). See [`src/vendor/winui/NOTICE.md`](src/vendor/winui/NOTICE.md) for details.
