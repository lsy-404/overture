// SPDX-License-Identifier: AGPL-3.0-or-later

import { createApp, h, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import { useWizard } from "../../src/stores/wizard";
import { usePolicy } from "../../src/stores/policy";
import { openPopup } from "../../src/lib/popup";
import StepAuthorize from "../../src/components/steps/StepAuthorize.vue";
import type { Recipe } from "../../src/lib/recipe/types";
import "../../src/theme";
import "../../src/style.css";

const query = new URLSearchParams(location.search);
const callback = query.get("callback");
const sessionKey = "overture-popup-probe-session";
const pkg = "a".repeat(64);
const account = "0123456789abcdef0123456789abcdef";
const root = document.getElementById("app")!;

if (callback) {
  root.innerHTML = "<h1>Popup boundary probe</h1><pre></pre><button>Complete OAuth</button><button>Send unrelated message</button>";
  root.querySelector("pre")!.textContent = JSON.stringify({
    opener: window.opener === null ? "null" : "present",
    referrer: document.referrer,
    width: innerWidth,
    height: innerHeight,
  }, null, 2);
  const buttons = root.querySelectorAll("button");
  buttons[0].hidden = callback !== "oauth";
  buttons[1].hidden = callback !== "oauth";
  buttons[0].onclick = () => {
    localStorage.setItem(sessionKey, "authorized");
    window.opener?.postMessage("oauth:complete", location.origin);
    window.close();
  };
  buttons[1].onclick = () => window.opener?.postMessage("oauth:unexpected", location.origin);
} else {
  localStorage.removeItem(sessionKey);
  i18n.global.locale.value = query.get("lang") === "zh" ? "zh-CN" : "en";
  const pinia = createPinia();
  setActivePinia(pinia);
  usePolicy().policy.oauthEnabled = true;
  const wizard = useWizard();
  const recipe: Recipe = {
    schema: 2, id: "popup-probe", name: "Popup probe", summary: "Popup behavior verification",
    issues: { url: "https://example.test/issues/new" },
    version: "1.0.0", tag: "v1.0.0", buildTime: "2026-01-01T00:00:00Z",
    package: { artifact: "overture.tar.gz", sha256: pkg },
    license: { id: "AGPL-3.0-or-later", text: "Probe" },
    authModes: ["oauth", "auto"], permissions: [], resources: [], capabilities: [],
    worker: { defaultName: "popup-probe", module: "worker/index.js" },
    steps: [{ id: "upload", label: "Upload" }],
  };
  wizard.adoptConfig({ ref: { owner: "example", repo: "popup-probe" }, tag: "v1.0.0", recipe, licenseText: "", termsText: "" });
  wizard.setAuthMode(query.get("mode") === "token" ? "auto" : "oauth");
  const blocked = ref(false);
  const sessionReads = ref(0);
  const lastOpen = ref("");
  const realOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    lastOpen.value = JSON.stringify({ url: String(url ?? ""), target, features });
    if (blocked.value) return null;
    const destination = String(url ?? "").startsWith("/oauth/authorize?")
      ? `${location.pathname}?callback=oauth`
      : url;
    return realOpen(destination, target, features);
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (path !== "/oauth/session" && path !== "/auth/token") return realFetch(input, init);
    sessionReads.value++;
    if (path === "/auth/token") localStorage.setItem(sessionKey, "authorized");
    const authorized = localStorage.getItem(sessionKey) === "authorized";
    const accountId = authorized && init?.method === "POST" ? account : null;
    return Response.json({ authorized, scope: authorized ? ["account.read"] : [],
      accounts: authorized ? [{ id: account, name: "Probe account" }] : [], accountId,
      pkg: authorized ? pkg : null, expiresAt: null, mode: authorized ? wizard.authMode : null });
  };
  createApp({ render: () => h("main", { style: "max-width: 880px; margin: 24px auto; padding: 24px" }, [
    h("h1", "Authorization popup probe"),
    h("p", "The relay is simulated. No real OAuth grant or API token is created."),
    h("nav", [h("a", { href: "?mode=oauth" }, "OAuth mode"), " | ", h("a", { href: "?mode=token" }, "Token mode")]),
    h("label", [h("input", { type: "checkbox", checked: blocked.value,
      onChange: (event: Event) => { blocked.value = (event.target as HTMLInputElement).checked; } }), "Simulate popup blocking"]),
    h("button", { onClick: () => window.postMessage("oauth:complete", location.origin) }, "Send unrelated source"),
    h("button", { onClick: () => openPopup(`http://127.0.0.1:${location.port}${location.pathname}?callback=token`, "token-boundary-probe", {
      width: 760, height: 820, keepOpener: false,
    }) }, "Open isolated window probe"),
    h("p", { id: "probe-status" }, `Authorized: ${wizard.authorized}; account: ${wizard.credentials.accountId || "none"}; session reads: ${sessionReads.value}`),
    h("pre", { style: "white-space: pre-wrap" }, lastOpen.value),
    h(StepAuthorize),
  ]) }).use(pinia).use(i18n).mount(root);
}
