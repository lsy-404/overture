// SPDX-License-Identifier: AGPL-3.0-or-later

// Exercise the base64 multipart size expected from a CASSIE-sized asset bucket.
import app from "../../worker/index";

const MiB = 1024 * 1024;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://relay.example";
const originalFetch = globalThis.fetch;
const checks: Array<[string, boolean]> = [];
let capturedLength = 0;
let capturedAuth = "";

async function run(): Promise<void> {
  try {
    // 20 MiB raw bytes encode to about 26.7 MiB before multipart framing.
    const raw = new Uint8Array(20 * MiB);
    const encoded = Buffer.from(raw).toString("base64");
    const form = new FormData();
    form.append("0".repeat(32), new Blob([encoded]), "asset");
    const request = new Request(`${ORIGIN}/cf/accounts/${ACCOUNT}/workers/assets/upload?base64=true`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Overture-Relay": "1",
        Authorization: "Bearer cfat_upload_session_token",
      },
      body: form,
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedLength = (await new Response(init?.body).arrayBuffer()).byteLength;
      capturedAuth = new Headers(init?.headers).get("Authorization") || "";
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    const response = await app.fetch(request, {} as Env);
    checks.push(["a 20 MiB asset bucket's base64 multipart upload passes the relay", response.status === 200]);
    checks.push(["the relayed body stays within the 36 MiB cap and preserves upload-session auth", capturedLength <= 36 * MiB && capturedAuth === "Bearer cfat_upload_session_token"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let failures = 0;
  for (const [label, passed] of checks) {
    if (passed) console.log("  PASS " + label);
    else {
      failures += 1;
      console.error("  FAIL " + label);
    }
  }
  console.log(checks.length - failures + "/" + checks.length + " assertions passed");
  if (failures > 0) process.exit(1);
}

void run();
