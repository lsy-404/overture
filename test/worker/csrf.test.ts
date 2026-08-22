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

// worker/csrf.ts's gate: the custom header is mandatory for every method;
// Origin remains mandatory for writes and must match when supplied, while a
// same-origin GET/HEAD may omit it because browsers do not always send one.

import { Hono } from "hono";
import { csrfGate } from "../../worker/csrf";

const app = new Hono<{ Bindings: Env }>();
app.use("*", csrfGate);
app.all("/probe", (c) => c.json({ ok: true }));

const SELF_ORIGIN = "https://relay.example";

async function call(headers: Record<string, string>, method = "GET"): Promise<Response> {
  return app.fetch(new Request(`${SELF_ORIGIN}/probe`, { method, headers }), {} as Env);
}

const checks: Array<[string, boolean, string?]> = [];

async function run(): Promise<void> {
  const missingHeader = await call({ Origin: SELF_ORIGIN });
  checks.push(["a request with no Overture-Relay header is rejected with 403", missingHeader.status === 403]);

  const wrongHeaderValue = await call({ "Overture-Relay": "true", Origin: SELF_ORIGIN });
  checks.push(['an Overture-Relay value other than "1" is rejected with 403', wrongHeaderValue.status === 403]);

  const readWithoutOrigin = await call({ "Overture-Relay": "1" });
  checks.push(["a same-origin GET with the relay header may omit Origin", readWithoutOrigin.status === 200]);

  const headWithoutOrigin = await call({ "Overture-Relay": "1" }, "HEAD");
  checks.push(["a same-origin HEAD with the relay header may omit Origin", headWithoutOrigin.status === 200]);

  const writeWithoutOrigin = await call({ "Overture-Relay": "1" }, "POST");
  checks.push(["a write with no Origin header remains rejected with 403", writeWithoutOrigin.status === 403]);

  const wrongOrigin = await call({ "Overture-Relay": "1", Origin: "https://evil.example" });
  checks.push(["an Origin that does not equal this deployment's own origin is rejected with 403", wrongOrigin.status === 403]);

  const ok = await call({ "Overture-Relay": "1", Origin: SELF_ORIGIN });
  checks.push(["the header present and Origin exactly matching passes through", ok.status === 200]);

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
