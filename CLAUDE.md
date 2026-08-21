# Contribution Privacy

- Do not put personal information into source files, documentation, commit messages, tags, or release notes.
- Never include private or session URLs, task numbers, internal decisions, or signatures in a commit or release note.
- Keep commit messages and release summaries concise, public, and limited to the user-visible change.

# Security invariants

These are not style preferences. A change that breaks one of them is a vulnerability:

- The Cloudflare OAuth access token exists only inside the `__Host-ov_session` cookie — AES-GCM
  encrypted, HttpOnly, SameSite=Strict — and the Worker's per-request memory while a call is being
  forwarded. It never reaches page JavaScript, a sandbox message, a log line, a URL, or KV, and
  `/oauth/session` never returns it. The R2 key pair exists only in the host frame's memory and
  sessionStorage.
- Everything that reads the session cookie is same-origin only: the `Overture-Relay` header plus an
  exact `Origin` match are required (GET included), and the relay refuses any account-scoped path
  whose account id is not the one the session selected. The OAuth client secret and both cookie keys
  are Workers Secrets, never vars.
- Both auth modes (`oauth` and `auto`) seal their credential into the same `__Host-ov_session` cookie, and
  neither ever returns a token to the page. Auto mode mints nothing and deletes nothing: the one token the
  user pastes both authenticates the deploy and — when the recipe declares a `cfApiToken` host secret — *is*
  the app's long-lived credential, written into the app's Worker Secret unchanged. The user creates that
  token themselves from the recipe's pre-filled creation link — the permissions the recipe declared
  (validated against `shared/cfTokenPermissions.ts`, the one authoritative key→name/danger table), plus one
  Overture adds and always discloses on that same page: `account_api_tokens` **read**. That read, and only
  read, is what lets the Worker call `GET .../tokens/{id}` after the paste to confirm what the token actually
  grants; it can never create, modify, or delete a token, and the deploy proceeds even when the user leaves
  it out. So a leak is still bounded by what they granted, not by anything Overture could widen. `cfApiToken`
  is a host-secret source for that pasted *app* token only; `apiToken` (the session credential) remains
  forbidden as a host-secret source. Revoke deletes nothing in auto mode — the token is the user's own.
- A package's `recipe.js` runs only inside `<iframe sandbox="allow-scripts">` (opaque origin, no
  `allow-same-origin`), and reaches the outside world only through the capability bridge.
- Every capability call is gated on the recipe having declared that capability, and every Cloudflare
  path is gated again by the Worker relay's allowlist. Neither gate may be widened to a prefix match.
- **The sandbox runs only the code that arrived in the package.** The frame's CSP admits the guest
  bootstrap by its own hash — never a nonce, which would be inherited by everything the recipe module
  imports — and `blob:` for the single import of `recipe.js`, after which the bootstrap removes
  `URL.createObjectURL`. No `'unsafe-inline'`, no `'unsafe-eval'`, no remote script source. A recipe may
  still fetch data; it may never turn fetched bytes into code. `test/fixtures/*-probe.html` is where this
  is proven in a real browser, since no unit test can. The host page's own CSP (`index.html`) is
  inherited into the sandboxed `srcdoc` document as an additional policy: its `script-src` must carry
  the bootstrap's hash and `blob:` too, or the sandbox breaks silently — `test/sandbox/csp_hash.test.ts`
  guards the hash.
- The relay must never become a general-purpose proxy, and must never log Authorization headers or
  request/response bodies.
- **No logging, anywhere.** This is a public deployer pointed at strangers' Cloudflare accounts, so it
  keeps no record of who deployed what: no `console.*` in the SPA or the Worker, no Workers
  observability, no analytics, no narration channel out of the sandbox. The one permitted diagnostic is
  a failure message attached to the step it happened in, shown to the user in their own browser and
  stored nowhere.
- **No persistence.** The Worker has no KV, no D1, no cache of its own. The deploy policy is plain
  Worker vars read per request. Nothing about a deployment survives the request that made it.
