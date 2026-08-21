# Overture backend — contract

`worker/` is the whole server side of Overture. One Worker serves the built wizard through the `ASSETS`
binding and answers the routes the wizard cannot call from a browser tab. This file is the spec for those
routes: what each one accepts, why it exists, and which properties are not negotiable.

**This Worker has no storage.** No KV, no D1, no Cache, no Durable Object, and it writes no logs. Every
response is computed from the incoming request and the Worker's own `wrangler.toml` vars. That is not an
implementation detail — it is the core trust premise of a public tool that other people's Cloudflare
credentials pass through: there is nowhere in this Worker for a credential, a policy edit, or a record of
who deployed what to end up.

## Why a relay exists at all

`api.cloudflare.com` returns no `Access-Control-Allow-*` header on any method, preflight included. A page
running on Overture's origin therefore cannot talk to it, no matter what the token allows. R2's
S3-compatible endpoint and GitHub's release-download host are the same story. So the browser sends those
three kinds of request to this Worker — its own origin — which forwards them.

That is the entire purpose. The relay adds no capability of its own. The deploy credential is an OAuth
token this Worker obtained from Cloudflare and sealed into the visitor's own cookie (§3): a `/cf/*` call
is authorised by unsealing that cookie, never by anything the page supplies, and nothing about the
session is stored server-side.

Four properties make this a relay instead of an open proxy, and a change that erodes any of them is a
vulnerability rather than a regression:

1. **Nothing reaches Cloudflare that is not in the table below**, matched on method plus an exact
   segment-by-segment path pattern. No prefix match, no variable-length pattern, no "and everything under
   this path".
2. **No credential is ever logged or persisted.** `Authorization` headers, request bodies, response
   bodies, and the R2 key pair are never written to observability, never cached, never put in KV.
3. **Failures are opaque.** Upstream error text is replaced by a fixed message wherever it could carry
   signing internals derived from a secret.
4. **Everything stateful is same-origin.** Any route that reads the session cookie demands the
   `Overture-Relay` header and an exact `Origin` match, the token is never returned to the page, and an
   account-scoped path must name the account the session selected.

## 1. Deploy policy — `GET /policy`

The deploy policy answers one question: *which GitHub repositories may this deployment install a package
from?* It is not state — it is a read-only view of two Worker vars, recomputed on every request by
`shared/policy.ts`'s `policyFromVars`:

- `allowlistEnabled` — `ALLOWLIST_ENABLED`. Unset or anything other than the literal `"false"` leaves it
  `true`. A package is third-party code that runs against a visitor's own Cloudflare account, so an
  operator has to switch the gate off deliberately; it is never off by default.
- `sources` — `ALLOWED_SOURCES`, a comma/whitespace separated list of `owner/repo` entries, normalised to
  lowercase, de-duplicated, capped at 200.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/policy` | none | Returns `{ allowlistEnabled, sources, oauthEnabled }` computed from this request's vars. Public: the wizard shows visitors which sources this deployment accepts, and `oauthEnabled` (`true` only when an `OAUTH_CLIENT_ID` is configured) tells it whether the OAuth sign-in mode is offerable at all. |

There is no write route, no session route, no admin token, and no KV. **An operator changes the policy by
editing `ALLOWLIST_ENABLED`/`ALLOWED_SOURCES` in `wrangler.toml` (or the dashboard) and redeploying** — the
same path as any other config change. Nothing in this Worker can alter its own policy at runtime.

## 2. Cloudflare API passthrough — `/cf/*`

The caller sends `/cf/<cf-api-path>` with exactly the method and body it would send to
`https://api.cloudflare.com/client/v4/<cf-api-path>` — but no credential. The Worker strips `/cf`, checks
the remaining path against the allowlist, drops whatever `Authorization` the caller supplied, injects the
session token unsealed from the cookie (§3), and forwards the request unchanged apart from hop headers
(`Host`, `Content-Length`, `cf-*`, `x-forwarded-*`). The response passes back untouched.

Two bindings gate the injection. The call must pass the same-origin gate (`Overture-Relay` header plus an
exact `Origin`), and a path under `/accounts/{accountId}` must name the account the session has selected —
one consent can span several accounts, and a package's `checks` may not read the ones the user did not
pick. The single exception is asset upload (`POST .../assets/upload`), marked `passthroughAuth` in the
table: it is authorised by the short-lived JWT Cloudflare issued for the upload session, so the Worker
never reads the cookie there and refuses the call outright unless the caller carries a well-formed
`Bearer` header of its own.

Anything not matching gets `403` with no upstream call. Path segments are read from `url.pathname`, which
keeps `%2F` un-decoded — what the allowlist validates is byte-for-byte what gets forwarded. Segments
marked opaque below must be non-empty and must not be `.`, `..`, or contain an encoded slash; their format
is otherwise not checked.

This is the second of two gates. A package's `recipe.js` first has to have declared the matching
capability (`src/lib/sandbox/protocol.ts`), and only then can the resulting call reach this table.

| Method | Path pattern | Used for |
|---|---|---|
| GET | `/accounts/{accountId}` | Account name and plan, shown on the target step |
| GET | `/accounts/{accountId}/r2/buckets` | Is R2 enabled, and which buckets the recipe's resources could match |
| POST | `/accounts/{accountId}/r2/buckets` | Create a bucket the recipe declared |
| GET | `/accounts/{accountId}/d1/database` | Read the account's D1 databases once, to match the recipe's resources against |
| POST | `/accounts/{accountId}/d1/database` | Create a D1 database the recipe declared |
| POST | `/accounts/{accountId}/d1/database/{dbId}/query` | Run the recipe's SQL steps (schema, seed rows) |
| GET | `/accounts/{accountId}/storage/kv/namespaces` | Read the account's KV namespaces once, to match the recipe's resources against |
| POST | `/accounts/{accountId}/storage/kv/namespaces` | Create a KV namespace the recipe declared |
| GET | `/accounts/{accountId}/workers/scripts` | Does the chosen Worker name already exist (fresh vs overwrite) |
| GET | `/accounts/{accountId}/workers/scripts/{scriptName}` | Script metadata for an overwrite |
| DELETE | `/accounts/{accountId}/workers/scripts/{scriptName}` | Full rebuild: drop the script before redeploying it |
| GET | `/accounts/{accountId}/workers/scripts/{scriptName}/settings` | Read bindings and vars off the live script before replacing it |
| GET | `/accounts/{accountId}/workers/scripts/{scriptName}/deployments` | Which version is live now |
| POST | `/accounts/{accountId}/workers/scripts/{scriptName}/versions` | Upload the new version (multipart) |
| POST | `/accounts/{accountId}/workers/scripts/{scriptName}/deployments` | Point traffic at the new version |
| POST | `/accounts/{accountId}/workers/scripts/{scriptName}/assets-upload-session` | Begin a static-asset upload |
| PUT | `/accounts/{accountId}/workers/scripts/{scriptName}/secrets` | Push the secrets the recipe declared |
| GET | `/accounts/{accountId}/workers/scripts/{scriptName}/schedules` | Read the cron triggers |
| PUT | `/accounts/{accountId}/workers/scripts/{scriptName}/schedules` | Write the cron triggers the recipe declared |
| POST | `/accounts/{accountId}/workers/assets/upload` | Upload asset bytes for an open session (`?base64=true`) |
| GET | `/accounts/{accountId}/workers/domains` | List custom domains, to spot an existing binding before overwriting |
| PUT | `/accounts/{accountId}/workers/domains` | Attach a custom domain in one call; it resolves the zone itself |
| GET | `/accounts/{accountId}/images/v1/stats` | Is Cloudflare Images on this account (the call fails when it is not) |
| GET | `/zones` | Resolve the zone behind a custom domain the user typed |
| GET | `/zones/{zoneId}/settings/image_resizing` | Are image transformations enabled on that zone |

`shared/cfAllowlist.ts` is the executable copy of this table. The two must be edited together, and an
entry belongs here only if some recipe step genuinely needs it — the table is a budget, not a convenience.

It sits in `shared/` because the relay is not its only reader. The wizard's package analyser resolves a
package's declared capabilities and `checks` paths against the same table, before the user is asked for a
token, to tell them which of these endpoints a deployment will reach and which paths the package named
that this table does not cover. A second copy would eventually disagree with this one, and the
disagreement would be the wizard promising one thing while the relay does another.

## 3. OAuth sign-in — `/oauth/*`

The deploy credential is obtained by the standard Authorization Code flow against Cloudflare's own OAuth
service, entirely server-side: the browser never sees the token, the code exchange happens in this Worker
with a `client_secret` held as a Workers Secret, and the result lives in an encrypted cookie only this
Worker can read.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/oauth/authorize` | Same-origin navigations only (`Sec-Fetch-Site: same-origin`). Validates `scope` (every entry within `shared/oauthScopes.ts`) and `pkg` (the package digest), signs both plus a CSPRNG nonce into `__Host-ov_state`, and redirects to Cloudflare's consent page. |
| GET | `/oauth/callback` | Verifies `state` against `__Host-ov_state` (HMAC, consumed on first use), exchanges the code server-side, reads `GET /accounts` with the fresh token, seals everything into `__Host-ov_session`, and answers a tiny page that signals `oauth:complete` to its opener and closes itself. `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and no data — not the token, not the scopes — in the message, the URL, or the page. |
| GET | `/oauth/session` | What the wizard may know: `{ authorized, scope, accounts, accountId, pkg, expiresAt, mode }`. Never the token. |
| POST | `/oauth/session` | Selects the deploy account. The id must be one the consent covered; the cookie is re-sealed with it. |
| POST | `/oauth/revoke` | Ends the session. Clears the cookie unconditionally; only `oauth` mode also tears the credential down upstream via the OAuth client (best-effort — the token also expires on its own). `auto`'s token is the user's own long-lived credential, so revoke never deletes it there — it only clears the local cookie. Always `200` with `{ ok, error? }`. |
| POST | `/auth/token` | The auto-mode entry point: accepts a pasted Cloudflare API token `{ token, mode: "auto", pkg }`, verifies it against Cloudflare (`GET /accounts`, then `tokens/verify`) rather than trusting its shape, and seals it into the same `__Host-ov_session` the OAuth callback fills. Returns the same view as `/oauth/session`; never the token. |

Auto mode reaches Cloudflare with a token the user pasted, sealed into the same session cookie the OAuth
callback fills — so `/cf/*` injection, the same-origin gate, and the account-id binding all behave
identically to OAuth. The mode only decides how the session is established. That one pasted token does
double duty: it authenticates the deploy, and — when the recipe declares a `cfApiToken` host secret — it
*is* the app's own long-lived credential, written into the app's Worker Secret unchanged. Overture never
mints a narrower token and never deletes the pasted one: the user created it with exactly the permissions
the recipe's pre-filled creation link declared, and it stays theirs.

Cookies: both carry the `__Host-` prefix, so a sibling host on the same registrable domain cannot toss
either one up to the parent — the login-CSRF session-fixation this closes is the whole reason the prefix
matters. `__Host-ov_state` is HMAC-signed, `SameSite=Lax` — it has to survive the cross-site top-level
return from the consent page — and is cleared the first time it is checked; `__Host-` forces `Path=/`, so
it is no longer scoped to `/oauth`. `__Host-ov_session` is AES-GCM encrypted, `SameSite=Strict`. Both are
`HttpOnly`, `Secure`, `Path=/`.

Both cookie keys are derived from the single `OAUTH_COOKIE_KEY` secret through HKDF under separate info
labels, so the key that signs the state cookie cannot decrypt the session cookie or be worked back to the
secret both come from. One secret is what an operator has to generate and keep; two independent keys is
what the crypto gets.

Configuration: `OAUTH_CLIENT_ID` and `OAUTH_REDIRECT_URI` are plain vars — the redirect URI is
deliberately not derived from the `Host` header. Two Workers Secrets, installed with `wrangler secret put`
and never present in `wrangler.toml`: `OAUTH_CLIENT_SECRET`, which Cloudflare issues with the OAuth
client, and `OAUTH_COOKIE_KEY`, which the operator generates and Cloudflare never sees.

Every route above except `authorize` and `callback` passes the same-origin gate: `Overture-Relay` header
present, `Origin` present and exactly this origin, anything else `403`.

## 4. R2 key-pair verification — `POST /r2/verify-keys`

Not a Cloudflare API call. Some recipes need an S3 key pair for the bucket they just created, and the only
honest way to tell the user their pair works is to sign a request with it. Body:
`{ accountId, bucketName?, accessKeyId, secretAccessKey }`, which must arrive as `application/json`; the
route also passes the same same-origin gate as the session routes.

The Worker signs (via `aws4fetch`, region `auto`, service `s3`) a bucket-scoped `HEAD` against
`https://{accountId}.r2.cloudflarestorage.com/{bucketName}`, or a `GET` at the account root when no bucket
is named. `accountId` must be 32 hex chars and `bucketName` must match R2's charset, because both land in
the signed request's host or path.

Sequencing: the bucket has to exist first (§2's `POST .../r2/buckets`), since the check is deliberately
bucket-scoped — R2's S3 layer does not reliably support account-root listing.

Response is always `200` with `{ ok: true }` or `{ ok: false, status, message }`, where `message` is one
of a fixed set. The upstream body is never forwarded: S3 error XML can echo the canonical request, which
is derived from the secret key. The key pair itself exists only for the duration of this request — it is
not logged, cached, or stored.

Known limitation: a key pair scoped to a *different* bucket the user also owns will still `200` against
its own bucket. The status code cannot distinguish "wrong keys" from "right keys, wrong bucket", so the
wizard names the bucket in the error it shows.

## 5. Release-asset download — `GET /github/release-asset?src=owner/repo&url=<asset-url>`

GitHub's asset host redirects to storage that sends no CORS headers, so the package bytes stream through
here. Two independent checks, both required:

1. `src` parses as `owner/repo` (`shared/package.ts`), and `url` is an
   `https://github.com/{owner}/{repo}/releases/download/…` URL **for that same repository**. A release
   body is attacker-controlled text, so checking the host is `github.com` is not enough — the download has
   to belong to the repo the user actually chose. Either check failing is a `400`.
2. That repository passes the deploy policy from §1. Otherwise `403`, with a message saying this Overture
   deployment only serves its allow-listed sources.

Only then does the Worker fetch, following GitHub's redirect and streaming the body back with CORS
headers. A declared `Content-Length` over 24 MiB (`MAX_ARTIFACT_BYTES`) is refused with `413`. Nothing
about the download is cached or recorded.

Note what this route is not: it takes a full URL, but it is not a fetcher. The only URLs it will ever
retrieve are release downloads of repositories an operator has allow-listed.

## 6. Same-origin

There is no CORS layer. The wizard is served by this same Worker, every route is same-origin, and no
`Access-Control-*` header is ever emitted. A separately-hosted frontend cannot talk to these routes — by
design, since the session cookie must never be spendable from another origin. Routes that read the
session additionally demand the `Overture-Relay` header and an exact `Origin` match (§3).

## 7. Size and abuse limits

- Request bodies over 20 MiB are refused with `413`, checked against the declared `Content-Length` first
  and the buffered length after. Worker version multipart uploads and asset chunks run a few MB, so this
  sits above real traffic and below the platform's own cap.
- Release assets are capped at 24 MiB, matching the SPA's own limit for the same artifact.
- No custom rate limiting beyond the platform's. This is a low-traffic deployment tool, not a public API;
  recorded here as a known limitation rather than something to build.

## 8. Static assets and SPA routing

Cloudflare consults the asset manifest before invoking this script, so a request only reaches the Worker
when no built file matched it. Unmatched paths go to `ASSETS.fetch`; when that answers `404` and the
request was a document navigation (`GET` with `text/html` in `Accept`), the Worker serves `/index.html`
instead so client-side routes such as `/settings` load on a cold URL. Non-document 404s stay 404s, and API
routes never reach this fallback because they matched a route already.
