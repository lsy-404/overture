// SPDX-License-Identifier: AGPL-3.0-or-later

import app from "../../worker/index";

const ORIGIN = "https://relay.example";
const oldSource = "wuyilingwei/OMEW";
const canonicalSource = "lsy-404/OMEW";
const assetUrl = `https://github.com/${canonicalSource}/releases/download/v1.0.0/overture.json`;

async function request(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await app.request(url, {}, { ALLOWED_SOURCES: oldSource } as Env);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  const transferred = await request(
    `${ORIGIN}/github/release-asset?src=${encodeURIComponent(oldSource)}&url=${encodeURIComponent(assetUrl)}`,
    async (input, init) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/wuyilingwei/OMEW") {
        checks.push(["the canonical lookup identifies the Worker to GitHub", new Headers(init?.headers).get("User-Agent") === "overture-release-relay"]);
        return new Response(JSON.stringify({ full_name: canonicalSource }));
      }
      if (url === assetUrl) return new Response("config", { headers: { "content-length": "6" } });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  checks.push(["an allow-listed former slug accepts assets from GitHub's canonical repository", transferred.status === 200 && await transferred.text() === "config"]);

  const mismatched = await request(
    `${ORIGIN}/github/release-asset?src=${encodeURIComponent(oldSource)}&url=${encodeURIComponent("https://github.com/evil/OMEW/releases/download/v1.0.0/overture.json")}`,
    async (input) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/wuyilingwei/OMEW") {
        return new Response(JSON.stringify({ full_name: canonicalSource }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  checks.push(["a canonical source cannot authorize another repository's assets", mismatched.status === 400]);

  const malformedIdentity = await request(
    `${ORIGIN}/github/release-asset?src=${encodeURIComponent(oldSource)}&url=${encodeURIComponent(assetUrl)}`,
    async () => new Response("{", { headers: { "content-type": "application/json" } }),
  );
  checks.push(["an unreadable GitHub identity response fails closed", malformedIdentity.status === 400]);

  const direct = `https://github.com/${oldSource}/releases/download/v1.0.0/overture.json`;
  const unchanged = await request(
    `${ORIGIN}/github/release-asset?src=${encodeURIComponent(oldSource)}&url=${encodeURIComponent(direct)}`,
    async (input) => {
      if (String(input) === direct) return new Response("config", { headers: { "content-length": "6" } });
      throw new Error(`Unexpected fetch: ${String(input)}`);
    },
  );
  checks.push(["an unchanged source does not require a GitHub identity lookup", unchanged.status === 200 && await unchanged.text() === "config"]);

  let failures = 0;
  for (const [label, passed, detail] of checks) {
    if (passed) console.log(`  PASS ${label}`);
    else {
      failures++;
      console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }
  console.log(`${checks.length - failures}/${checks.length} assertions passed`);
  if (failures > 0) process.exit(1);
}

run();
