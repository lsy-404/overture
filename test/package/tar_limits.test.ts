// SPDX-License-Identifier: AGPL-3.0-or-later

import { gzipSync } from "node:zlib";
import { unpackArtifact } from "../../src/lib/package/tar";

const MiB = 1024 * 1024;
const checks: Array<[string, boolean]> = [];

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name).subarray(0, 100), 0);
  const sizeText = size.toString(8).padStart(11, "0") + "\0";
  header.set(new TextEncoder().encode(sizeText), 124);
  header[156] = 48;
  return header;
}

function archiveWithPayloadSize(size: number): Uint8Array {
  const paddedSize = Math.ceil(size / 512) * 512;
  const tar = new Uint8Array(512 + paddedSize + 1024);
  tar.set(tarHeader("assets/data.bin", size));
  return new Uint8Array(gzipSync(tar));
}

function archiveWithEntries(count: number): Uint8Array {
  const tar = new Uint8Array(count * 512 + 1024);
  for (let index = 0; index < count; index += 1) {
    tar.set(tarHeader(`entry-${index}`, 0), index * 512);
  }
  return new Uint8Array(gzipSync(tar));
}

async function run(): Promise<void> {
  const fixedTarBytes = 512 + 1024;
  const exactExpanded = await unpackArtifact(archiveWithPayloadSize(64 * MiB - fixedTarBytes));
  checks.push(["a tar archive expanding to exactly 64 MiB is accepted", exactExpanded.has("assets/data.bin")]);

  let expandedRejected = false;
  try {
    await unpackArtifact(archiveWithPayloadSize(64 * MiB + 512 - fixedTarBytes));
  } catch (error) {
    expandedRejected = error instanceof Error && error.message.includes("size limit");
  }
  checks.push(["an archive expanding beyond 64 MiB is rejected", expandedRejected]);

  const exactEntries = await unpackArtifact(archiveWithEntries(20_000));
  checks.push(["an archive with 20,000 entries is accepted", exactEntries.size === 20_000]);

  let entryLimitRejected = false;
  try {
    await unpackArtifact(archiveWithEntries(20_001));
  } catch (error) {
    entryLimitRejected = error instanceof Error && error.message.includes("too many files");
  }
  checks.push(["an archive with more than 20,000 entries is rejected", entryLimitRejected]);

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
