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

// The gate every route that reads or writes ov_session sits behind, GET
// included: an operator can self-host Overture on the same eTLD+1 as the
// package it deploys (deploy.example.com next to music.example.com), so
// SameSite alone does not draw the boundary here — a fixed header a
// cross-site <form>/<img>/top-level navigation cannot set does. Origin is a
// second, independent check: it must be present and equal to this exact
// origin, not merely non-conflicting. Neither check is skipped when the
// other one already failed.

import type { Context, Next } from "hono";
import { jsonResponse } from "./http";

type RelayContext = Context<{ Bindings: Env }>;

const RELAY_HEADER_VALUE = "1";

export async function csrfGate(c: RelayContext, next: Next): Promise<Response | void> {
  if (c.req.header("Overture-Relay") !== RELAY_HEADER_VALUE) {
    return jsonResponse(c, 403, { ok: false, error: "Missing Overture-Relay header" });
  }
  const origin = c.req.header("Origin");
  if (!origin) {
    return jsonResponse(c, 403, { ok: false, error: "Missing Origin header" });
  }
  if (origin !== new URL(c.req.url).origin) {
    return jsonResponse(c, 403, { ok: false, error: "Origin does not match this deployment" });
  }
  await next();
}
