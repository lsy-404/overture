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

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // The deployed Worker can serve this from a subpath or a custom domain —
  // a relative base works in either without a build-time host guess.
  base: "./",
  plugins: [vue()],
  server: {
    port: 5174,
    // In production this app is same-origin with its own relay and policy
    // routes (see worker/index.ts) — `npm run dev` alone can't replicate that,
    // so forward those paths to a separately-running `wrangler dev`.
    proxy: {
      "/cf": "http://localhost:8787",
      "/r2": "http://localhost:8787",
      "/github": "http://localhost:8787",
      "/policy": "http://localhost:8787",
    },
  },
});
