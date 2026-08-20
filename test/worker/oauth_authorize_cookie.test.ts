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

// The ov_state cookie the /oauth/authorize route actually emits. A sibling host
// on the same registrable domain must not be able to toss this cookie up to the
// parent, or it becomes a login-CSRF session-fixation vector: the __Host- prefix
// (host-only, which forces Path=/) is what removes that capability, so the name
// and Path are asserted against a real request, not just serializeCookie's shape.

import app from "../../worker/index";

const ENV = {
  OAUTH_CLIENT_ID: "test-client-id",
  OAUTH_REDIRECT_URI: "https://deploy.example.com/oauth/callback",
  OAUTH_COOKIE_KEY: "cookie-key-testing-only",
} as unknown as Env;

const AUTHORIZE = `/oauth/authorize?scope=${encodeURIComponent("d1.read d1.write")}&pkg=${"a".repeat(64)}`;

async function run(): Promise<void> {
  const ok = await app.request(AUTHORIZE, { headers: { "Sec-Fetch-Site": "same-origin" } }, ENV);
  const setCookie = ok.headers.get("Set-Cookie") || "";

  const blocked = await app.request(AUTHORIZE, { headers: { "Sec-Fetch-Site": "cross-site" } }, ENV);

  const checks: Array<[string, boolean, string?]> = [
    ["a same-origin authorize navigation redirects to consent", ok.status === 302, `status ${ok.status}`],
    ["the state cookie carries the __Host- prefix", setCookie.includes("__Host-ov_state="), setCookie],
    // The prefix is only honoured by browsers when Path=/ and Secure are present;
    // the old Path=/oauth scoping would make __Host- silently invalid.
    ["the state cookie is Path=/", /(?:^|;\s*)Path=\/(?:;|$)/.test(setCookie), setCookie],
    ["the state cookie is Secure and HttpOnly", /Secure/.test(setCookie) && /HttpOnly/.test(setCookie), setCookie],
    ["the state cookie is SameSite=Lax", /SameSite=Lax/.test(setCookie), setCookie],
    ["it is never emitted under the tossable bare ov_state name", !/(?:^|;\s*)ov_state=/.test(setCookie), setCookie],
    ["a cross-site authorize navigation is refused", blocked.status === 403, `status ${blocked.status}`],
  ];

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
