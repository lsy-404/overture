// SPDX-License-Identifier: AGPL-3.0-or-later

import { createTurnstileWidget } from "../../src/lib/deploy/turnstile";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const originalFetch = globalThis.fetch;
let captured: { url: string; init?: RequestInit } | undefined;

function respond(result: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ success: true, result }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  respond({ sitekey: "0x4AAAAA-widget", secret: "turnstile-secret-value" });
  const created = await createTurnstileWidget(ACCOUNT, {
    name: "Contact form",
    domains: ["app.example.com", "203.0.113.1"],
    mode: "managed",
  });
  const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;

  respond({ sitekey: "0x4AAAAA-widget" });
  let missingSecret = "";
  try {
    await createTurnstileWidget(ACCOUNT, { name: "Contact form", domains: ["app.example.com"], mode: "managed" });
  } catch (error) {
    missingSecret = error instanceof Error ? error.message : String(error);
  }

  const checks: Array<[string, boolean, string?]> = [
    ["Turnstile creation uses the exact account widgets endpoint", captured?.url === `/cf/accounts/${ACCOUNT}/challenges/widgets`, captured?.url],
    ["Turnstile creation preserves only declared fields", body.name === "Contact form" && Array.isArray(body.domains) && body.mode === "managed", JSON.stringify(body)],
    ["a complete response exposes the sitekey and secret to the host", created.sitekey === "0x4AAAAA-widget" && created.secret === "turnstile-secret-value"],
    ["a response without a secret is rejected", /didn't return a Turnstile secret/.test(missingSecret), missingSecret],
  ];
  let failures = 0;
  for (const [label, passed, detail] of checks) {
    if (passed) console.log(`  PASS ${label}`);
    else {
      failures++;
      console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }
  console.log(`${checks.length - failures}/${checks.length} assertions passed`);
  if (failures) process.exit(1);
}

main().finally(() => {
  globalThis.fetch = originalFetch;
});
