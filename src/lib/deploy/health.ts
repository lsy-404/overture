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

// A just-deployed Worker is a different origin that sends no CORS headers, and
// the relay is not a general-purpose proxy, so a `cors` fetch would reject
// identically on success and on failure. `no-cors` is the only mode that can
// tell "the origin answered" from "nothing was reached" — it cannot read the
// status, so `status` stays 0 and this is a reachability probe, not a health
// check. Deployment success is really established by the traffic switch having
// succeeded; this is a best-effort signal on top of it.
export async function probeReachable(
  url: string,
  attempts = 3,
  delayMs = 1500,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fetch(url, { mode: "no-cors", cache: "no-store", signal });
      return { ok: true, status: 0 };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { ok: false, status: 0 };
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { ok: false, status: 0 };
}
