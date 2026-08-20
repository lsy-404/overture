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

// worker/oauth.ts's ov_session cookie: AES-GCM encrypt/decrypt round trip,
// rejection under the wrong key, rejection of tampered ciphertext (GCM's own
// authentication tag), and rejection of a payload that decrypts cleanly but
// does not have the shape a session is supposed to have.

import { decryptSession, encryptSession, type SessionPayload } from "../../worker/oauth";

const SECRET_A = "session-secret-a-testing-only";
const SECRET_B = "session-secret-b-testing-only";

const payload: SessionPayload = {
  token: "cfoat_test_token_value",
  scope: ["d1.read", "d1.write"],
  accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Test Account" }],
  pkg: "a".repeat(64),
  expiresAt: Math.floor(Date.now() / 1000) + 3599,
};

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  const cookie = await encryptSession(payload, SECRET_A);
  checks.push([
    "the encrypted cookie value never contains the plaintext token",
    !cookie.includes(payload.token),
  ]);

  const decrypted = await decryptSession(cookie, SECRET_A);
  checks.push([
    "decrypting with the same secret round-trips the payload exactly",
    !!decrypted && JSON.stringify(decrypted) === JSON.stringify(payload),
  ]);

  checks.push(["decrypting with a different secret is rejected", (await decryptSession(cookie, SECRET_B)) === null]);

  const [ivPart, dataPart] = cookie.split(".");
  const tamperedData = dataPart.slice(0, -1) + (dataPart.endsWith("A") ? "B" : "A");
  checks.push([
    "a single flipped ciphertext character fails AES-GCM's own authentication",
    (await decryptSession(`${ivPart}.${tamperedData}`, SECRET_A)) === null,
  ]);

  checks.push(["a value with no iv/ciphertext separator never throws, just returns null", (await decryptSession("not-a-cookie", SECRET_A)) === null]);
  checks.push(["an empty string is rejected without throwing", (await decryptSession("", SECRET_A)) === null]);

  // A blob that decrypts fine under AES-GCM but whose JSON shape is not a
  // SessionPayload must still be rejected — the guard that protects a route
  // reading `session.token`/`session.accounts` from ever seeing `undefined`
  // if a cookie from an older payload shape is ever replayed.
  const malformed = { token: "only-a-token", scope: [], pkg: "", expiresAt: 0 } as unknown as SessionPayload;
  const malformedCookie = await encryptSession(malformed, SECRET_A);
  checks.push([
    "a decryptable but incorrectly shaped payload (missing accounts) is rejected",
    (await decryptSession(malformedCookie, SECRET_A)) === null,
  ]);

  let failures = 0;
  for (const [label, passed, detail] of checks) {
    if (passed) console.log(`  PASS ${label}`);
    else {
      failures++;
      console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }
  console.log(`${checks.length - failures}/${checks.length} assertions passed`);
  if (failures > 0) {
    console.error(`${failures} FAILURE(S)`);
    process.exit(1);
  }
}

run();
