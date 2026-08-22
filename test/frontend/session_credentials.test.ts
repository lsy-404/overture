// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Host credentials may survive a page reload within one browser tab, but never
// survive an explicit credential clear or leave sessionStorage.

import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useWizard } from "../../src/stores/wizard";

class MemorySessionStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const storage = new MemorySessionStorage();
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });

setActivePinia(createPinia());
const firstTabLoad = useWizard();
firstTabLoad.credentials.cfApiToken = "test-token";
firstTabLoad.credentials.r2AccessKeyId = "test-access-key";
firstTabLoad.credentials.r2SecretAccessKey = "test-secret-key";
await nextTick();

const tokenStoredInSession = storage.getItem("overture_cf_api_token") === "test-token";
const tokenNotStoredWithR2Pair = !storage.getItem("overture_r2_keys")?.includes("test-token");

setActivePinia(createPinia());
const reloadedInSameTab = useWizard();
const tokenRestoredAfterReload = reloadedInSameTab.credentials.cfApiToken === "test-token";

reloadedInSameTab.clearCredentials(false);
const failedDeployDropsStoredToken = storage.getItem("overture_cf_api_token") === null
  && reloadedInSameTab.credentials.cfApiToken === "test-token";

reloadedInSameTab.clearCredentials(true);
const explicitClearRemovesToken = storage.getItem("overture_cf_api_token") === null
  && reloadedInSameTab.credentials.cfApiToken === "";

reloadedInSameTab.credentials.cfApiToken = "test-token";
await nextTick();
reloadedInSameTab.setAuthMode("oauth");
const changingModesDropsStoredToken = storage.getItem("overture_cf_api_token") === null
  && reloadedInSameTab.credentials.cfApiToken === "";

const checks: Array<[string, boolean]> = [
  ["a pasted Cloudflare token is stored only in sessionStorage", tokenStoredInSession],
  ["the R2 storage entry never contains the Cloudflare token", tokenNotStoredWithR2Pair],
  ["the Cloudflare token reloads within the same browser tab", tokenRestoredAfterReload],
  ["a failed deploy removes the stored token but preserves its in-memory retry value", failedDeployDropsStoredToken],
  ["clearCredentials(true) removes both stored and in-memory Cloudflare tokens", explicitClearRemovesToken],
  ["changing auth mode removes a stale stored Cloudflare token", changingModesDropsStoredToken],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}
console.log(`${checks.length - failures}/${checks.length} assertions passed`);
if (failures > 0) process.exit(1);
