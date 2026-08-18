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

import { callCfJson } from "../relay";

const CONTEXT = "Workers Scripts Write";

export interface CustomDomain {
  hostname: string;
  zoneId: string;
  environment?: string;
}

interface DomainRow {
  hostname?: string;
  zone_id?: string;
  service?: string;
  environment?: string;
}

/** Cloudflare lists every Worker domain on the account, so this filters by service. */
export async function listCustomDomains(
  token: string,
  accountId: string,
  script: string,
  signal?: AbortSignal,
): Promise<CustomDomain[]> {
  const rows = await callCfJson<DomainRow[]>(
    token,
    `/accounts/${accountId}/workers/domains`,
    signal ? { signal } : undefined,
    CONTEXT,
  );
  return (rows || [])
    .filter((row) => row.service === script && row.hostname && row.zone_id)
    .map((row) => ({ hostname: row.hostname as string, zoneId: row.zone_id as string, environment: row.environment }));
}

/**
 * Resolves the zone a hostname belongs to. A hostname can be several labels
 * below its zone, so labels are dropped from the left until a zone matches or
 * only the registrable pair is left.
 */
export async function lookupZone(token: string, hostname: string, signal?: AbortSignal): Promise<{ id: string; name: string } | null> {
  const labels = hostname.trim().toLowerCase().replace(/\.+$/, "").split(".");
  for (let start = 0; start <= Math.max(0, labels.length - 2); start++) {
    const candidate = labels.slice(start).join(".");
    const zones = await callCfJson<Array<{ id?: string; name?: string }>>(
      token,
      `/zones?name=${encodeURIComponent(candidate)}`,
      signal ? { signal } : undefined,
      "Zone Read",
    );
    const zone = zones.find((entry) => entry.id);
    if (zone?.id) return { id: zone.id, name: zone.name || candidate };
  }
  return null;
}

/** `zoneId` is known when re-attaching a domain read off the live script; otherwise it is looked up. */
export async function attachCustomDomain(
  token: string,
  accountId: string,
  script: string,
  hostname: string,
  zoneId?: string,
  environment = "production",
  signal?: AbortSignal,
): Promise<void> {
  let zone = zoneId;
  if (!zone) {
    const found = await lookupZone(token, hostname, signal);
    if (!found) throw new Error(`No Cloudflare zone on this account covers ${hostname}`);
    zone = found.id;
  }
  await callCfJson(
    token,
    `/accounts/${accountId}/workers/domains`,
    { method: "PUT", body: JSON.stringify({ hostname, service: script, zone_id: zone, environment }), signal },
    CONTEXT,
  );
}

/** Best effort: a domain that refuses to re-attach is reported, never fatal — the deployment is already live. */
export async function restoreCustomDomains(
  token: string,
  accountId: string,
  script: string,
  domains: CustomDomain[],
  signal?: AbortSignal,
): Promise<string[]> {
  const failed: string[] = [];
  for (const domain of domains) {
    try {
      await attachCustomDomain(token, accountId, script, domain.hostname, domain.zoneId, domain.environment || "production", signal);
    } catch {
      failed.push(domain.hostname);
    }
  }
  return failed;
}
