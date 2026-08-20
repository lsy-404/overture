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

// index.html's own CSP is a second, independent policy the sandboxed recipe
// frame's srcdoc document has to satisfy too — verified in a real browser
// (see the comment above the <meta> tag in index.html) to inherit from its
// creator regardless of the frame's own, separately declared policy. That
// makes the hash embedded there load-bearing: if src/lib/sandbox/guest.ts's
// GUEST_BOOTSTRAP ever changes without index.html's hash following it, the
// sandbox stops loading its own bootstrap script and every deployment breaks
// silently, in production, with nothing but a CSP console warning to explain
// it. This test is what catches that before it ships.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BRIDGE_PROTOCOL } from "../../src/lib/sandbox/protocol";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const missing: string[] = [];

function read(file: string): string {
  try {
    return fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    missing.push(file);
    return "";
  }
}

const guestSource = read("src/lib/sandbox/guest.ts");
const indexHtml = read("index.html");

function extractBootstrap(source: string): string | null {
  const marker = "export const GUEST_BOOTSTRAP = `";
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const end = source.lastIndexOf("`;");
  if (end < start) return null;
  return source.slice(start + marker.length, end).replace("${BRIDGE_PROTOCOL}", String(BRIDGE_PROTOCOL));
}

function sha256Base64(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

const bootstrap = extractBootstrap(guestSource);
const actualHash = bootstrap ? sha256Base64(bootstrap) : "";

const cspMatch = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
const csp = cspMatch ? cspMatch[1] : "";
const embeddedHash = (csp.match(/'sha256-([^']+)'/) || [])[1] || "";

const scriptSrc = (csp.match(/script-src ([^;]+)/) || [])[1] || "";

const checks: Array<[string, boolean, string?]> = [
  ["GUEST_BOOTSTRAP was found in guest.ts", !!bootstrap, "could not locate the GUEST_BOOTSTRAP template literal"],
  ["index.html declares a Content-Security-Policy meta tag", csp.length > 0],
  ["index.html's script-src hash matches GUEST_BOOTSTRAP's real hash",
    embeddedHash.length > 0 && embeddedHash === actualHash,
    `index.html has 'sha256-${embeddedHash}', GUEST_BOOTSTRAP hashes to 'sha256-${actualHash}'`],
  ["script-src allows blob: for the recipe module import", /\bblob:/.test(scriptSrc)],
  ["script-src does not carry 'unsafe-inline'", !/'unsafe-inline'/.test(scriptSrc)],
  ["script-src does not carry 'unsafe-eval'", !/'unsafe-eval'/.test(scriptSrc)],
  ["no directive anywhere in the policy carries 'unsafe-eval'", !/'unsafe-eval'/.test(csp)],
  ["the policy sets a default-src fallback", /default-src\s+'self'/.test(csp)],
  ["the policy blocks plugin content with object-src 'none'", /object-src\s+'none'/.test(csp)],
];

let failures = 0;
for (const [label, passed, detail] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

if (missing.length > 0) console.error(`  missing source files: ${missing.join(", ")}`);
console.log(`${checks.length - failures}/${checks.length} assertions passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
