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

// The scopes this Overture's OAuth client was registered to hold — its ceiling.
//
// An authorize request may ask for any subset of these and Cloudflare will show
// the user exactly that subset on its consent screen. It may not ask for
// anything outside them: the client was never granted it, so the request would
// fail at Cloudflare with an error the user cannot act on. Checking here turns
// that into a package this deployment refuses to load, which is something a user
// can act on.
//
// The list is transcribed from the client's own registration, one entry at a
// time. There is no discovery endpoint to sync it from, so it is maintained by
// hand: an operator who registers their own client with a different set has to
// edit this file to match. Keep it free of Worker and DOM globals — the relay
// validates against it and so does the package analyser.
//
// Note the spelling is Cloudflare's OAuth namespace (dotted, lowercase), which
// is a different namespace from the Title Case permission-group names used by
// classic API tokens. The two do not map one to one and must not be mixed.

export const OAUTH_SCOPES: readonly string[] = [
  // Developer Platform — everything that can be bound into a Worker.
  "agent-memory.write",
  "browser-rendering.read",
  "browser-rendering.write",
  "cf-agents.read",
  "cf-agents.write",
  "cloud-connector.read",
  "cloud-connector.write",
  "cloudchamber.read",
  "cloudchamber.write",
  "constellation.read",
  "constellation.write",
  "containers.read",
  "containers.write",
  "d1.read",
  "d1.write",
  "flagship.evaluate",
  "flagship.read",
  "flagship.write",
  "mcp-portals.read",
  "mcp-portals.write",
  "messaging.edit",
  "messaging.read",
  "page.read",
  "page.write",
  "pipelines.read",
  "pipelines.send",
  "pipelines.write",
  "pubsub.read",
  "pubsub.write",
  // Hyperdrive.
  "query-cache.read",
  "query-cache.write",
  "queues.read",
  "queues.write",
  "r2-catalog.read",
  "r2-catalog.write",
  "r2-catalog-sql.read",
  "realtime.admin",
  "realtime.read",
  "realtime.write",
  "secrets-store.read",
  "secrets-store.write",
  "vectorize.read",
  "vectorize.write",
  "workers-ci.read",
  "workers-ci.write",
  "workers-kv-storage.read",
  "workers-kv-storage.write",
  "workers-observability.read",
  "workers-observability.write",
  "workers-observability-telemetry.write",
  "workers-r2.read",
  "workers-r2.write",
  "workers-r2-bucket-item.read",
  "workers-r2-bucket-item.write",
  "workers-routes.read",
  "workers-routes.write",
  "workers-scripts.bind",
  // Shown as "Workers Editor" on the consent screen.
  "workers-scripts.edit",
  "workers-scripts.read",
  "workers-scripts.write",
  "workers-tail.read",

  // AI and Machine Learning.
  "agw.read",

  // DNS and Zones.
  "zone.read",
  "zone-settings.read",

  // Analytics and Logs.
  "account-analytics.read",

  // Media.
  "images.read",

  // Account and Billing.
  "account-api-gateway.read",
  "account-api-gateway.write",
  "account-custom-asset.read",
  "account-custom-asset.write",
  "account-settings.read",
  "billing.read",

  // Other.
  "artifacts.read",
  "artifacts.write",
  "resource-library.read",
  "resource-library.write",
  "resource-sharing.read",
];

const KNOWN = new Set(OAUTH_SCOPES);

export function isKnownScope(scope: string): boolean {
  return KNOWN.has(scope);
}

/** The scopes in `requested` this client was never registered to hold. */
export function unknownScopes(requested: readonly string[]): string[] {
  return requested.filter((scope) => !KNOWN.has(scope));
}

/**
 * Parses the space-separated `scope` of an authorize request or a token
 * response. Order is not significant and duplicates collapse, so the result is
 * sorted and de-duplicated — two requests for the same authority compare equal.
 */
export function parseScopeParam(value: string): string[] {
  return [...new Set(value.split(/\s+/).filter(Boolean))].sort();
}

export function formatScopeParam(scopes: readonly string[]): string {
  return [...new Set(scopes)].sort().join(" ");
}
