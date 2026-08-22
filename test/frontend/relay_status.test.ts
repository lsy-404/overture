// SPDX-License-Identifier: AGPL-3.0-or-later

import { CfApiError, callCfJson, callCfMultipart, callCfMultipartBearer, callCfNoContent } from "../../src/lib/relay";
import { CF_UPSTREAM_STATUS_HEADER } from "../../shared/cfRelay";

const realFetch = globalThis.fetch;
const checks: Array<[string, boolean, string?]> = [];

function upstreamFailure(status: number): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json", [CF_UPSTREAM_STATUS_HEADER]: String(status) },
  });
}

async function capturesStatus(action: () => Promise<unknown>, status: number): Promise<boolean> {
  globalThis.fetch = (async () => upstreamFailure(status)) as typeof fetch;
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof CfApiError && error.status === status && error.code === 10000 && error.message === "Authentication error";
  }
}

async function run(): Promise<void> {
  checks.push(["JSON calls preserve the Cloudflare status carried by a 200 relay response", await capturesStatus(() => callCfJson("/accounts/a/r2/buckets"), 403)]);
  checks.push(["empty-body calls preserve the Cloudflare status carried by a 200 relay response", await capturesStatus(() => callCfNoContent("/accounts/a/workers/scripts/x", { method: "DELETE" }), 429)]);
  checks.push(["multipart session calls preserve the Cloudflare status carried by a 200 relay response", await capturesStatus(() => callCfMultipart("/accounts/a/workers/scripts/x/versions", new FormData()), 500)]);
  checks.push(["multipart bearer calls preserve the Cloudflare status carried by a 200 relay response", await capturesStatus(() => callCfMultipartBearer("jwt", "/accounts/a/workers/assets/upload", new FormData()), 401)]);

  globalThis.fetch = realFetch;
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

void run();
