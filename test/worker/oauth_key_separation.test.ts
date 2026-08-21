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

// One secret keys both cookies, so the only thing keeping the state key from
// standing in for the session key is the HKDF label each is derived under.
// That makes the separation worth asserting on its own: a future edit that
// reuses one label for both would leave every test above still passing, since
// each cookie would keep round-tripping perfectly well under a shared key.

import { decryptSession, deriveCookieSubkey, encryptSession, signStateCookie, verifyStateCookie } from "../../worker/oauth";

const MASTER = "cookie-key-testing-only";
const OTHER = "a-different-cookie-key";

function bytes(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].join(",");
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  const state = await deriveCookieSubkey(MASTER, "state");
  const session = await deriveCookieSubkey(MASTER, "session");

  checks.push(["each purpose derives a 256-bit subkey", state.byteLength === 32 && session.byteLength === 32]);
  checks.push(["the two purposes derive different subkeys from one secret", bytes(state) !== bytes(session)]);
  checks.push([
    "a purpose derives the same subkey every time",
    bytes(await deriveCookieSubkey(MASTER, "state")) === bytes(state),
  ]);
  checks.push([
    "a different secret derives a different subkey for the same purpose",
    bytes(await deriveCookieSubkey(OTHER, "state")) !== bytes(state),
  ]);

  // The cookies are keyed off the same secret, so each has to stay readable
  // only by the half of the scheme that wrote it.
  const sessionCookie = await encryptSession(
    {
      token: "cfoat_test_token_value",
      scope: ["d1.read"],
      accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Test Account" }],
      pkg: "a".repeat(64),
      expiresAt: Math.floor(Date.now() / 1000) + 3599,
      mode: "oauth",
    },
    MASTER,
  );
  const stateCookie = await signStateCookie({ stateHash: "x", scope: ["d1.read"], pkg: "b".repeat(64), iat: Math.floor(Date.now() / 1000) }, MASTER);

  checks.push(["a session cookie does not verify as a state cookie", (await verifyStateCookie(sessionCookie, MASTER)) === null]);
  checks.push(["a state cookie does not decrypt as a session cookie", (await decryptSession(stateCookie, MASTER)) === null]);

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
