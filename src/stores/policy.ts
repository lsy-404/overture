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

import { defineStore } from "pinia";
import { ref } from "vue";
import { isSourceAllowed } from "../../shared/policy";
import type { SourceRef } from "../../shared/package";
import { getPolicy, type OverturePolicy } from "../lib/policyClient";

/** The two screens this app has. The policy page is reachable at /settings. */
export type AppView = "wizard" | "policy";

const SETTINGS_RE = /\/settings\/?$/;

// Guarded rather than assumed: the wizard store composes this store for its
// oauthEnabled read, and a test harness that instantiates the wizard store
// outside a browser has no `location` to read a route from.
function viewFromLocation(): AppView {
  return typeof location !== "undefined" && SETTINGS_RE.test(location.pathname) ? "policy" : "wizard";
}

// The app may be served from a subpath, so a route change edits the tail of
// whatever path is already there instead of assuming the site root.
function pathFor(view: AppView): string {
  const root = location.pathname.replace(SETTINGS_RE, "").replace(/\/+$/, "");
  return view === "policy" ? `${root}/settings` : `${root}/`;
}

export const usePolicy = defineStore("policy", () => {
  const view = ref<AppView>(viewFromLocation());
  if (typeof addEventListener === "function") {
    addEventListener("popstate", () => {
      view.value = viewFromLocation();
    });
  }

  function show(next: AppView) {
    if (view.value === next) return;
    history.pushState(null, "", pathFor(next));
    view.value = next;
  }

  // Until the real answer arrives, assume the strictest policy: allowlist on
  // with nothing on it, and oauth off, so no source or sign-in option is
  // offered by accident.
  const policy = ref<OverturePolicy>({ allowlistEnabled: true, sources: [], oauthEnabled: false });
  const loaded = ref(false);
  const loading = ref(false);

  async function load() {
    if (loading.value) return;
    loading.value = true;
    policy.value = await getPolicy();
    loaded.value = true;
    loading.value = false;
  }

  function allows(ref_: SourceRef): boolean {
    return isSourceAllowed(policy.value, ref_);
  }

  return {
    view,
    show,
    policy,
    loaded,
    loading,
    load,
    allows,
  };
});
