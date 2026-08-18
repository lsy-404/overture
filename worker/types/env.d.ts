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

interface Env {
  /** Built SPA (dist/), bound via [assets] in wrangler.toml. */
  ASSETS: Fetcher;
  // Comma-separated, exact-match allowlist of cross-origin callers permitted to
  // read the relay routes. The wizard's own same-origin calls never need it.
  // Read per request so it can change without a code change.
  ALLOWED_ORIGINS?: string;
  // Deploy policy, computed fresh on every request (shared/policy.ts). Unset
  // ALLOWLIST_ENABLED means the allowlist is on; anything but the literal
  // "false" leaves it on.
  ALLOWLIST_ENABLED?: string;
  // Comma/whitespace separated owner/repo entries the allowlist accepts.
  ALLOWED_SOURCES?: string;
}
