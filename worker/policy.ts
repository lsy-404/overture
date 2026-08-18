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

// Read-only: the policy is computed from the Worker's own vars on every
// request. Nothing is stored, nothing is written, and there is no admin
// token — an operator changes the policy by editing wrangler config and
// redeploying.

import type { Context } from "hono";
import { policyFromVars } from "../shared/policy";
import { jsonResponse } from "./cors";

type RelayContext = Context<{ Bindings: Env }>;

export function handleGetPolicy(c: RelayContext): Response {
  return jsonResponse(c, 200, policyFromVars(c.env));
}
