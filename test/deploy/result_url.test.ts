// SPDX-License-Identifier: AGPL-3.0-or-later

import { normalizeResultUrl } from "../../src/lib/engine/capabilities";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

check("an empty optional result URL is omitted", normalizeResultUrl("") === undefined);
check("an HTTPS result URL is retained", normalizeResultUrl("https://app.example.com") === "https://app.example.com");

let insecureMessage = "";
try {
  normalizeResultUrl("http://app.example.com");
} catch (error) {
  insecureMessage = error instanceof Error ? error.message : String(error);
}
check("an HTTP result URL is still rejected", insecureMessage === "the result URL must be https", insecureMessage);

if (failures > 0) process.exit(1);
