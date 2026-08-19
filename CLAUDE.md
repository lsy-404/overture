# Contribution Privacy

- Do not put personal information into source files, documentation, commit messages, tags, or release notes.
- Never include private or session URLs, task numbers, internal decisions, or signatures in a commit or release note.
- Keep commit messages and release summaries concise, public, and limited to the user-visible change.

# Security invariants

These are not style preferences. A change that breaks one of them is a vulnerability:

- The Cloudflare API token and R2 key pair exist only in the host frame's memory and sessionStorage.
  They never enter a sandbox message, a log line, a URL, or KV.
- A package's `recipe.js` runs only inside `<iframe sandbox="allow-scripts">` (opaque origin, no
  `allow-same-origin`), and reaches the outside world only through the capability bridge.
- Every capability call is gated on the recipe having declared that capability, and every Cloudflare
  path is gated again by the Worker relay's allowlist. Neither gate may be widened to a prefix match.
- **The sandbox runs only the code that arrived in the package.** The frame's CSP admits the guest
  bootstrap by its own hash — never a nonce, which would be inherited by everything the recipe module
  imports — and `blob:` for the single import of `recipe.js`, after which the bootstrap removes
  `URL.createObjectURL`. No `'unsafe-inline'`, no `'unsafe-eval'`, no remote script source. A recipe may
  still fetch data; it may never turn fetched bytes into code. `test/fixtures/*-probe.html` is where this
  is proven in a real browser, since no unit test can.
- The relay must never become a general-purpose proxy, and must never log Authorization headers or
  request/response bodies.
- **No logging, anywhere.** This is a public deployer pointed at strangers' Cloudflare accounts, so it
  keeps no record of who deployed what: no `console.*` in the SPA or the Worker, no Workers
  observability, no analytics, no narration channel out of the sandbox. The one permitted diagnostic is
  a failure message attached to the step it happened in, shown to the user in their own browser and
  stored nowhere.
- **No persistence.** The Worker has no KV, no D1, no cache of its own. The deploy policy is plain
  Worker vars read per request. Nothing about a deployment survives the request that made it.
