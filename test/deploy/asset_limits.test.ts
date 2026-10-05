// SPDX-License-Identifier: AGPL-3.0-or-later

import { uploadAssets } from "../../src/lib/deploy/assets";

const MiB = 1024 * 1024;
const checks: Array<[string, boolean]> = [];
let calls = 0;
let nextBuckets: string[][] = [];
const originalFetch = globalThis.fetch;

function installUploadSessionStub(): void {
  calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      success: true,
      result: { jwt: "session-token", buckets: nextBuckets },
    }));
  }) as typeof fetch;
}

function inputFor(sizes: number[]) {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const buffer = new ArrayBuffer(total);
  const files = new Map<string, Uint8Array>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  let offset = 0;
  sizes.forEach((size, index) => {
    const name = "asset-" + index + ".opus";
    const hash = index.toString(16).padStart(32, "0");
    files.set("assets/" + name, new Uint8Array(buffer, offset, size));
    manifest["/" + name] = { hash, size };
    offset += size;
  });
  return { accountId: "account", script: "test-worker", files, manifest, assetsDir: "assets" };
}

async function run(): Promise<void> {
  try {
    nextBuckets = [];
    installUploadSessionStub();
    const exactAggregate = await uploadAssets(inputFor([16 * MiB, 16 * MiB, 16 * MiB, 16 * MiB]));
    checks.push(["a 64 MiB aggregate static asset set reaches the upload session", exactAggregate === "session-token" && calls === 1]);

    installUploadSessionStub();
    let aggregateRejected = false;
    try {
      await uploadAssets(inputFor([13 * MiB, 13 * MiB, 13 * MiB, 13 * MiB, 13 * MiB]));
    } catch {
      aggregateRejected = true;
    }
    checks.push(["an aggregate above 64 MiB is rejected before network access", aggregateRejected && calls === 0]);

    installUploadSessionStub();
    const exactFile = await uploadAssets(inputFor([25 * MiB]));
    checks.push(["a 25 MiB static file meets Cloudflare's per-file ceiling", exactFile === "session-token" && calls === 1]);

    installUploadSessionStub();
    let fileRejected = false;
    try {
      await uploadAssets(inputFor([25 * MiB + 1]));
    } catch {
      fileRejected = true;
    }
    checks.push(["a static file above 25 MiB is rejected before network access", fileRejected && calls === 0]);

    const empty = new Uint8Array(0);
    const makeCountInput = (count: number) => {
      const files = new Map<string, Uint8Array>();
      const manifest: Record<string, { hash: string; size: number }> = {};
      for (let index = 0; index < count; index += 1) {
        const name = "asset-" + index;
        files.set("assets/" + name, empty);
        manifest["/" + name] = { hash: index.toString(16).padStart(32, "0"), size: 0 };
      }
      return { accountId: "account", script: "test-worker", files, manifest, assetsDir: "assets" };
    };

    installUploadSessionStub();
    const exactCount = await uploadAssets(makeCountInput(20_000));
    checks.push(["20,000 static files meet the Cloudflare Free plan count", exactCount === "session-token" && calls === 1]);

    installUploadSessionStub();
    let countRejected = false;
    try {
      await uploadAssets(makeCountInput(20_001));
    } catch {
      countRejected = true;
    }
    checks.push(["more than 20,000 static files are rejected before network access", countRejected && calls === 0]);

    nextBuckets = [["0".repeat(32), "1".padStart(32, "0")]];
    installUploadSessionStub();
    let bucketRejected = false;
    try {
      await uploadAssets(inputFor([15 * MiB, 15 * MiB]));
    } catch (error) {
      bucketRejected = error instanceof Error && error.message.includes("bucket exceeds");
    }
    checks.push(["a Cloudflare bucket too large for one bounded relay request is rejected before upload", bucketRejected && calls === 1]);
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
