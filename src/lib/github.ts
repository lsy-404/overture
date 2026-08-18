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

// api.github.com sends CORS headers, so listing releases happens straight from
// the browser and bills the visitor's own rate limit. Only the asset bytes go
// through the relay.

import { isDeployable, type GithubRelease, type SourceRef } from "../../shared/package";

const GITHUB_API = "https://api.github.com";

async function githubJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  // A repository with no releases, or none the visitor can see, 404s. That is an
  // empty result rather than a failure the user can act on.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status})`);
  return (await response.json()) as T;
}

/**
 * Releases carrying a deploy package, newest first as GitHub orders them.
 * Non-deployable releases are dropped: without both fixed-name assets served
 * from this repository's own downloads there is nothing for the wizard to read.
 */
export async function fetchReleases(ref: SourceRef): Promise<GithubRelease[]> {
  const base = `${GITHUB_API}/repos/${ref.owner}/${ref.repo}`;
  // The list endpoint is the flakier of the two: GitHub API incidents have had it
  // answer 200 with an empty array, and later serve an HTML error page the parse
  // rejects outright, while single-release lookups kept working. Treat an empty
  // list and a failed request the same way and fall back to the latest release so
  // a deploy is still possible.
  try {
    const releases = await githubJson<GithubRelease[]>(`${base}/releases?per_page=50`);
    if (Array.isArray(releases) && releases.length > 0) {
      return releases.filter((release) => isDeployable(release, ref));
    }
  } catch {
    // Fall through to the single-release lookup.
  }
  const latest = await githubJson<GithubRelease>(`${base}/releases/latest`);
  if (!latest || !isDeployable(latest, ref)) return [];
  return [latest];
}
