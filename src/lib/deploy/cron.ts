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

// Every version upload clears whatever schedule was live before it, so this runs
// after the traffic switch — restoring the crons read from the live script, or
// setting whatever the recipe asked for. Nothing to write means nothing to do:
// the upload already left the script scheduleless.
export async function setCron(accountId: string, script: string, crons: string[], signal?: AbortSignal): Promise<void> {
  if (crons.length === 0) return;
  await callCfJson(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/schedules`,
    { method: "PUT", body: JSON.stringify(crons.map((cron) => ({ cron }))), signal },
    "Workers Scripts Write",
  );
}
