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

// worker/oauth.ts's ov_state cookie: CSPRNG nonce generation, HMAC sign/verify
// (tamper and cross-secret rejection, expiry), scope-parameter validation,
// package-hash validation, and the plain cookie serialize/parse helpers. Same
// no-framework style as allowlist.test.ts, discovered by test/run-all.sh.

import {
  expireCookie,
  generateStateNonce,
  hashStateNonce,
  isValidPackageHash,
  parseAndValidateScope,
  parseCookies,
  serializeCookie,
  signStateCookie,
  STATE_COOKIE_MAX_AGE_SECONDS,
  stateNonceMatches,
  verifyStateCookie,
  type StatePayload,
} from "../../worker/oauth";

const SECRET_A = "state-secret-a-testing-only";
const SECRET_B = "state-secret-b-testing-only";
const PKG = "a".repeat(64);

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  const nonceA = generateStateNonce();
  const nonceB = generateStateNonce();
  checks.push(["state nonces are long and url-safe", /^[A-Za-z0-9_-]{40,}$/.test(nonceA)]);
  checks.push(["two state nonces differ", nonceA !== nonceB]);

  const stateHash = await hashStateNonce(nonceA, SECRET_A);
  checks.push(["a nonce's own hash matches", await stateNonceMatches(nonceA, stateHash, SECRET_A)]);
  checks.push(["a different nonce's hash does not match", !(await stateNonceMatches(nonceB, stateHash, SECRET_A))]);
  checks.push([
    "the same nonce hashed under a different secret does not match",
    !(await stateNonceMatches(nonceA, stateHash, SECRET_B)),
  ]);

  const payload: StatePayload = {
    stateHash,
    scope: ["d1.read", "d1.write"],
    pkg: PKG,
    iat: Math.floor(Date.now() / 1000),
  };
  const cookie = await signStateCookie(payload, SECRET_A);
  const verified = await verifyStateCookie(cookie, SECRET_A);
  checks.push([
    "a signed state cookie verifies and round-trips its payload",
    !!verified && JSON.stringify(verified) === JSON.stringify(payload),
  ]);
  checks.push(["a state cookie signed with a different secret is rejected", (await verifyStateCookie(cookie, SECRET_B)) === null]);

  const [origBody, origSig] = cookie.split(".");
  const flippedBody = origBody.slice(0, -1) + (origBody.endsWith("A") ? "B" : "A");
  checks.push([
    "a tampered state cookie body fails signature verification",
    (await verifyStateCookie(`${flippedBody}.${origSig}`, SECRET_A)) === null,
  ]);
  checks.push(["a cookie value with no signature separator is rejected", (await verifyStateCookie(origBody, SECRET_A)) === null]);

  const staleIat = Math.floor(Date.now() / 1000) - STATE_COOKIE_MAX_AGE_SECONDS - 1;
  const staleCookie = await signStateCookie({ ...payload, iat: staleIat }, SECRET_A);
  checks.push(["an expired state cookie is rejected even with a valid signature", (await verifyStateCookie(staleCookie, SECRET_A)) === null]);

  checks.push([
    "a known, space-separated scope list validates, sorts and de-duplicates",
    JSON.stringify(parseAndValidateScope("workers-scripts.write d1.read d1.read")) === JSON.stringify(["d1.read", "workers-scripts.write"]),
  ]);
  checks.push(["an empty scope string is rejected", parseAndValidateScope("") === null]);
  checks.push(["a whitespace-only scope string is rejected", parseAndValidateScope("   ") === null]);
  checks.push([
    "one unknown scope invalidates the whole request, not just that entry",
    parseAndValidateScope("d1.read not-a-real-scope") === null,
  ]);

  checks.push(["a 64-hex package hash validates", isValidPackageHash("a".repeat(64))]);
  checks.push(["an upper-case 64-hex package hash validates", isValidPackageHash("A".repeat(64))]);
  checks.push(["a 63-char package hash is rejected", !isValidPackageHash("a".repeat(63))]);
  checks.push(["a non-hex package hash is rejected", !isValidPackageHash("g".repeat(64))]);

  const serialized = serializeCookie("ov_state", "abc", { path: "/oauth", sameSite: "Lax", maxAgeSeconds: 600 });
  checks.push([
    "serializeCookie sets HttpOnly, Secure, SameSite, Path and Max-Age",
    /HttpOnly/.test(serialized) &&
      /Secure/.test(serialized) &&
      /SameSite=Lax/.test(serialized) &&
      /Path=\/oauth/.test(serialized) &&
      /Max-Age=600/.test(serialized),
  ]);

  const expired = expireCookie("ov_state", { path: "/oauth", sameSite: "Lax" });
  checks.push(["expireCookie sets Max-Age=0", /Max-Age=0/.test(expired)]);

  const parsed = parseCookies("ov_state=abc123; __Host-ov_session=def456; malformed");
  checks.push([
    "parseCookies reads multiple cookies and skips an entry with no '='",
    parsed.ov_state === "abc123" && parsed["__Host-ov_session"] === "def456" && Object.keys(parsed).length === 2,
  ]);
  checks.push(["parseCookies on an absent header returns empty", Object.keys(parseCookies(undefined)).length === 0]);

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
