// SPDX-License-Identifier: AGPL-3.0-or-later

import { METHOD_GATES } from "../../src/lib/sandbox/protocol";

const result = METHOD_GATES["turnstile.provision"] === "turnstile";
if (!result) {
  console.error("Turnstile provisioning must stay behind the Turnstile capability gate");
  process.exit(1);
}
console.log("1/1 assertions passed");
