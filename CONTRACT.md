# Overture backend — contract

`worker/` is the whole server side of Overture. One Worker serves the built wizard through the `ASSETS`
binding and answers the routes the wizard cannot call from a browser tab. This file is the spec for those
routes: what each one accepts, why it exists, and which properties are not negotiable.

**This Worker has no storage.** No KV, no D1, no Cache, no Durable Object, and it writes no logs. Every
response is computed from the incoming request and the Worker's own `wrangler.toml` vars. That is not an
implementation detail — it is the core trust premise of a public tool that other people's Cloudflare API
tokens pass through: there is nowhere in this Worker for a credential, a policy edit, or a record of who
deployed what to end up.

## Why a relay exists at all

`api.cloudflare.com` returns no `Access-Control-Allow-*` header on any method, preflight included. A page
running on Overture's origin therefore cannot talk to it, no matter what the token allows. R2's
S3-compatible endpoint and GitHub's release-download host are the same story. So the browser sends those
three kinds of request to this Worker, which forwards them and adds CORS headers on the way back.

That is the entire purpose. The relay adds no capability of its own: every request already carries the
credential it needs, and the Worker never mints, stores, or substitutes one.

Three properties make this a relay instead of an open proxy, and a change that erodes any of them is a
vulnerability rather than a regression:

1. **Nothing reaches Cloudflare that is not in the table below**, matched on method plus an exact
   segment-by-segment path pattern. No prefix match, no variable-length pattern, no "and everything under
   this path".
2. **No credential is ever logged or persisted.** `Authorization` headers, request bodies, response
   bodies, and the R2 key pair are never written to observability, never cached, never put in KV.
3. **Failures are opaque.** Upstream error text is replaced by a fixed message wherever it could carry
   signing internals derived from a secret.

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
| GET | `/policy` | none | Returns `{ allowlistEnabled, sources }` computed from this request's vars. Public: the wizard shows visitors which sources this deployment accepts. |

There is no write route, no session route, no admin token, and no KV. **An operator changes the policy by
editing `ALLOWLIST_ENABLED`/`ALLOWED_SOURCES` in `wrangler.toml` (or the dashboard) and redeploying** — the
same path as any other config change. Nothing in this Worker can alter its own policy at runtime.

## 2. Cloudflare API passthrough — `/cf/*`

The caller sends `/cf/<cf-api-path>` with exactly the method, body, and `Authorization: Bearer <token>` it
would send to `https://api.cloudflare.com/client/v4/<cf-api-path>`. The Worker strips `/cf`, checks the
remaining path against the allowlist, and forwards it unchanged apart from hop headers (`Host`,
`Content-Length`, `cf-*`, `x-forwarded-*`). The response passes back untouched with CORS headers added.

Anything not matching gets `403` with no upstream call. Path segments are read from `url.pathname`, which
keeps `%2F` un-decoded — what the allowlist validates is byte-for-byte what gets forwarded. Segments
marked opaque below must be non-empty and must not be `.`, `..`, or contain an encoded slash; their format
is otherwise not checked.

This is the second of two gates. A package's `recipe.js` first has to have declared the matching
capability (`src/lib/sandbox/protocol.ts`), and only then can the resulting call reach this table.

| Method | Path pattern | Used for |
|---|---|---|
| GET | `/accounts/{accountId}/tokens/verify` | Is the pasted API token live and scoped to this account |
| GET | `/accounts/{accountId}/tokens/{tokenId}` | Read the token's policies for the permission audit the recipe asks for |
| GET | `/accounts/{accountId}` | Account name and plan, shown on the target step |
| GET | `/accounts/{accountId}/r2/buckets` | Is R2 enabled, and which buckets already exist |
| POST | `/accounts/{accountId}/r2/buckets` | Create a bucket the recipe declared |
| GET | `/accounts/{accountId}/d1/database` | List D1 databases (existing-name detection) |
| POST | `/accounts/{accountId}/d1/database` | Create a D1 database the recipe declared |
| POST | `/accounts/{accountId}/d1/database/{dbId}/query` | Run the recipe's SQL steps (schema, seed rows) |
| GET | `/accounts/{accountId}/storage/kv/namespaces` | List KV namespaces (existing-name detection) |
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

## 3. R2 key-pair verification — `POST /r2/verify-keys`

Not a Cloudflare API call. Some recipes need an S3 key pair for the bucket they just created, and the only
honest way to tell the user their pair works is to sign a request with it. Body:
`{ accountId, bucketName?, accessKeyId, secretAccessKey }`.

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

## 4. Release-asset download — `GET /github/release-asset?src=owner/repo&url=<asset-url>`

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

## 5. CORS

- `Access-Control-Allow-Origin`: exact match against the comma-separated `ALLOWED_ORIGINS` var. Arbitrary
  `Origin` headers are never reflected, and there are no wildcards. Requests without an `Origin` (the
  wizard's own same-origin calls) get no such header and do not need one; the var exists so a
  separately-hosted frontend fork can still reach these routes.
- `Access-Control-Allow-Methods`: `GET, POST, PUT, DELETE, OPTIONS`
- `Access-Control-Allow-Headers`: `Authorization, Content-Type`
- `OPTIONS` is answered `204` for every route.
- `Access-Control-Allow-Credentials` stays unset. Nothing here uses cookies — bearer tokens only.

## 6. Size and abuse limits

- Request bodies over 20 MiB are refused with `413`, checked against the declared `Content-Length` first
  and the buffered length after. Worker version multipart uploads and asset chunks run a few MB, so this
  sits above real traffic and below the platform's own cap.
- Release assets are capped at 24 MiB, matching the SPA's own limit for the same artifact.
- No custom rate limiting beyond the platform's. This is a low-traffic deployment tool, not a public API;
  recorded here as a known limitation rather than something to build.

## 7. Static assets and SPA routing

Cloudflare consults the asset manifest before invoking this script, so a request only reaches the Worker
when no built file matched it. Unmatched paths go to `ASSETS.fetch`; when that answers `404` and the
request was a document navigation (`GET` with `text/html` in `Accept`), the Worker serves `/index.html`
instead so client-side routes such as `/settings` load on a cold URL. Non-document 404s stay 404s, and API
routes never reach this fallback because they matched a route already.
