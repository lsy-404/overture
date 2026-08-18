// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Gzip + tar reader built on DecompressionStream. The archive is third-party
// data, so both the expanded size and the entry count are capped, and an entry
// whose name escapes the package is dropped rather than stored.

const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 1000;

function readTarText(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(bytes.slice(start, end)).replace(/\0.*$/, "").trim();
}

function readTarOctal(bytes: Uint8Array, start: number, end: number): number {
  const text = readTarText(bytes, start, end).replace(/[^0-7].*$/, "");
  return text ? parseInt(text, 8) : 0;
}

/** `tar` archiving a directory writes `./`-prefixed names; recipe paths never have one. */
function normalizeName(name: string): string {
  return name.replace(/^(\.\/)+/, "");
}

/** Entry names are package-relative; anything that could escape is refused. */
function isContainedName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return !name.split("/").some((segment) => segment === "..");
}

export async function unpackArtifact(archive: Uint8Array): Promise<Map<string, Uint8Array>> {
  let decompressed: Uint8Array;
  try {
    const stream = new Blob([archive.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_UNPACKED_BYTES) throw new Error("Deploy package expands beyond the size limit");
      chunks.push(part.value);
    }
    decompressed = new Uint8Array(total);
    let writeOffset = 0;
    for (const chunk of chunks) {
      decompressed.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("size limit")) throw error;
    throw new Error("Deploy package is not a valid gzip archive");
  }
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let entries = 0;
  while (offset + 512 <= decompressed.byteLength) {
    const header = decompressed.subarray(offset, offset + 512);
    let empty = true;
    for (const byte of header) {
      if (byte !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) break;
    const name = readTarText(decompressed, offset, offset + 100);
    const prefix = readTarText(decompressed, offset + 345, offset + 500);
    const rawName = prefix ? `${prefix}/${name}` : name;
    const fullName = normalizeName(rawName);
    const size = readTarOctal(decompressed, offset + 124, offset + 136);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!rawName || dataEnd > decompressed.byteLength) throw new Error("Deploy package contains an invalid tar entry");
    if (++entries > MAX_ENTRIES) throw new Error("Deploy package contains too many files");
    const type = decompressed[offset + 156];
    if ((type === 0 || type === 48) && fullName && isContainedName(fullName)) {
      files.set(fullName, decompressed.slice(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function textFile(files: Map<string, Uint8Array>, name: string): string {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Deploy package is missing ${name}`);
  return new TextDecoder().decode(bytes);
}
