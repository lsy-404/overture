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

// The SPA and this Worker are always the same origin — there is no separately
// hosted frontend fork to grant cross-origin access to, so there is no CORS
// layer here at all (no Access-Control-* headers, no OPTIONS handling). A
// cross-site caller that tries anyway gets a plain 404 or a same-origin-only
// rejection from a route's own check, never a permissive header.

import type { Context } from "hono";

type RelayContext = Context<{ Bindings: Env }>;

export function jsonResponse(c: RelayContext, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
