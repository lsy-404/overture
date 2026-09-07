// SPDX-License-Identifier: AGPL-3.0-or-later

// A browser Worker upload crosses two fetch boundaries: FormData serializes it
// for the same-origin relay, then cfProxy forwards those exact bytes upstream.
// Keep PUT (first deployment) and POST (new version) here, because a direct
// Cloudflare smoke test cannot cover that relay boundary.

import app from "../../worker/index";
import { encryptSession, type SessionPayload } from "../../worker/oauth";
import { CF_UPSTREAM_STATUS_HEADER } from "../../shared/cfRelay";

const ORIGIN = "https://relay.example";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SESSION_KEY = "multipart-relay-test-session-key";
const env = { OAUTH_COOKIE_KEY: SESSION_KEY } as Env;
const originalFetch = globalThis.fetch;

interface UpstreamCall {
  url: string;
  init: RequestInit;
  body: Uint8Array;
}

let upstream: UpstreamCall | null = null;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function sessionCookie(): Promise<string> {
  const session: SessionPayload = {
    token: "cfat_auto_session_token",
    scope: [],
    accounts: [{ id: ACCOUNT, name: "Selected account" }],
    accountId: ACCOUNT,
    pkg: "a".repeat(64),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    mode: "auto",
  };
  return `__Host-ov_session=${await encryptSession(session, SESSION_KEY)}`;
}

async function multipartRequest(path: string, method: "PUT" | "POST"): Promise<{ request: Request; bytes: Uint8Array; contentType: string }> {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: "worker.js", bindings: [] })], { type: "application/json" }), "metadata");
  form.append("worker.js", new Blob(["export default { fetch() { return new Response('ok'); } };"], { type: "application/javascript+module" }), "worker.js");
  const request = new Request(`${ORIGIN}/cf${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      "Overture-Relay": "1",
      Cookie: await sessionCookie(),
    },
    body: form,
  });
  return {
    request,
    bytes: new Uint8Array(await request.clone().arrayBuffer()),
    contentType: request.headers.get("Content-Type") || "",
  };
}

function stubUpstream(status: number, body: unknown): void {
  upstream = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    upstream = {
      url: String(input),
      init: init || {},
      body: new Uint8Array(await new Response(init?.body).arrayBuffer()),
    };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function forwardedCorrectly(path: string, method: string, contentType: string, bytes: Uint8Array): boolean {
  const headers = upstream ? new Headers(upstream.init.headers) : new Headers();
  return !!upstream
    && upstream.url === `https://api.cloudflare.com/client/v4${path}`
    && upstream.init.method === method
    && headers.get("Authorization") === "Bearer cfat_auto_session_token"
    && headers.get("Content-Type") === contentType
    && !headers.has("Cookie")
    && !headers.has("Origin")
    && !headers.has("Overture-Relay")
    && bytesEqual(upstream.body, bytes);
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  try {
    const scriptPath = `/accounts/${ACCOUNT}/workers/scripts/waline-on-worker`;

    stubUpstream(201, { success: true, result: { id: "waline-on-worker" } });
    const fresh = await multipartRequest(scriptPath, "PUT");
    const freshResponse = await app.fetch(fresh.request, env);
    checks.push(["fresh Worker PUT reaches the upstream API", freshResponse.status === 201]);
    checks.push(["fresh Worker PUT preserves multipart bytes, boundary, path, method, and auto-session authorization", forwardedCorrectly(scriptPath, "PUT", fresh.contentType, fresh.bytes)]);

    const versionPath = `${scriptPath}/versions`;
    const cloudflareError = { success: false, errors: [{ code: 10021, message: "version upload rejected" }], result: null };
    stubUpstream(403, cloudflareError);
    const version = await multipartRequest(versionPath, "POST");
    const versionResponse = await app.fetch(version.request, env);
    checks.push(["version POST preserves multipart bytes, boundary, path, method, and auto-session authorization", forwardedCorrectly(versionPath, "POST", version.contentType, version.bytes)]);
    checks.push(["a multipart upstream failure stays readable through the relay", versionResponse.status === 200 && versionResponse.headers.get(CF_UPSTREAM_STATUS_HEADER) === "403"]);
    checks.push(["a multipart upstream failure preserves Cloudflare's JSON envelope", JSON.stringify(await versionResponse.json()) === JSON.stringify(cloudflareError)]);
  } finally {
    globalThis.fetch = originalFetch;
  }

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
