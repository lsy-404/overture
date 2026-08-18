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

// Web-standard crypto helpers. Used for package integrity and to back the
// `crypto.*` capability a recipe calls when it needs a generated secret.

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

// Ambiguous glyphs are left out so a generated password survives being read off
// one screen and typed into another.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generatePassword(length = 12): string {
  const size = Math.min(Math.max(Math.trunc(length) || 12, 4), 128);
  const values = crypto.getRandomValues(new Uint32Array(size));
  let out = "";
  for (const value of values) out += PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length];
  return out;
}

export function randomBase64(byteLength = 48): string {
  const size = Math.min(Math.max(Math.trunc(byteLength) || 48, 8), 256);
  return base64Bytes(crypto.getRandomValues(new Uint8Array(size)));
}
