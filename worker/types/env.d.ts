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
  // Deploy policy, computed fresh on every request (shared/policy.ts). Unset
  // ALLOWLIST_ENABLED means the allowlist is on; anything but the literal
  // "false" leaves it on.
  ALLOWLIST_ENABLED?: string;
  // Comma/whitespace separated owner/repo entries the allowlist accepts.
  ALLOWED_SOURCES?: string;
  // Cloudflare OAuth client, registered once by the operator. Both are public:
  // they travel in the authorize URL's query string regardless of where they
  // are read from.
  OAUTH_CLIENT_ID: string;
  OAUTH_REDIRECT_URI: string;
  // Workers secrets (`wrangler secret put <name>`), never in wrangler.toml.
  // The client secret is issued by Cloudflare with the OAuth client and
  // authenticates the token exchange and revoke calls against it.
  OAUTH_CLIENT_SECRET: string;
  // A random string the operator generates; Cloudflare knows nothing about it.
  // worker/oauth.ts derives both cookie keys from it — an HMAC key for ov_state
  // and an AES-GCM key for ov_session — under separate HKDF labels, so neither
  // derived key can stand in for the other.
  OAUTH_COOKIE_KEY: string;
}
