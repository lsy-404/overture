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

// What a deployable release looks like. Shared by the SPA (which lists releases
// straight from api.github.com, billing the visitor's own rate limit) and the
// Worker (which streams the asset bytes and re-checks their origin). Keep this
// file free of Worker and DOM globals.
//
// Two assets, deliberately separate:
//
//   overture.json     the install configuration — identity, licence and terms
//                     text, the permission table, account checks, the storage
//                     and Worker declaration, the questions to ask, and the
//                     digest of the package below. Kilobytes.
//   overture.tar.gz   the install data package — recipe.js, the Worker module,
//                     static assets, SQL. Megabytes.
//
// The wizard needs the whole configuration before it can ask the user anything,
// and needs the package only once they press deploy. Keeping them apart means
// terms, permissions and resource names all render off one small fetch.

export const PACKAGE_CONFIG_NAME = "overture.json";
export const PACKAGE_ARTIFACT_NAME = "overture.tar.gz";

export const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;

export interface GithubAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

export interface GithubRelease {
  tag_name?: string;
  name?: string;
  published_at?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  html_url?: string;
  assets?: GithubAsset[];
}

/** A GitHub repository a package can come from. */
export interface SourceRef {
  owner: string;
  repo: string;
}

// GitHub's own rules: 1–39 chars for an owner, and repo names allow dot and
// underscore too. Anything else is rejected outright rather than normalised,
// so a crafted `?src=` can't smuggle a path segment.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function parseSource(value: string): SourceRef | null {
  const parts = value.trim().replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  return { owner, repo };
}

export function sourceSlug(ref: SourceRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * Accepts what a visitor who has never heard of "owner/repo" would actually
 * paste — a full GitHub URL, with or without a scheme, a trailing slash, a
 * `.git` suffix, or extra path segments (`/releases`, `/tree/main`, …) — and
 * reduces it to the same shape `parseSource` expects before handing off to it.
 * `?src=` keeps using `parseSource` directly: that value is already exact.
 */
export function parseSourceLoose(value: string): SourceRef | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const looksLikeUrl = trimmed.includes("://") || /^(www\.)?github\.com\//i.test(trimmed);
  if (!looksLikeUrl) return parseSource(trimmed);
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    return parseSource(`${segments[0]}/${segments[1].replace(/\.git$/i, "")}`);
  } catch {
    return null;
  }
}

/**
 * Only accept assets served from this source's own release downloads. Both the
 * SPA and the relay rely on it: a release body is attacker-controlled text, so
 * the download URL has to be checked against the repository the user actually
 * chose, not merely against github.com.
 */
export function isReleaseAssetUrl(value: string, ref: SourceRef): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith(`/${ref.owner}/${ref.repo}/releases/download/`)
    );
  } catch {
    return false;
  }
}

export function assetOf(release: GithubRelease, name: string, ref: SourceRef): GithubAsset | null {
  const asset = (release.assets || []).find((candidate) => candidate.name === name);
  if (!asset?.browser_download_url) return null;
  return isReleaseAssetUrl(asset.browser_download_url, ref) ? asset : null;
}

export function isDeployable(release: GithubRelease, ref: SourceRef): boolean {
  return !!assetOf(release, PACKAGE_CONFIG_NAME, ref) && !!assetOf(release, PACKAGE_ARTIFACT_NAME, ref);
}

/** Tags are compared with the leading `v` ignored — nothing else is normalised. */
export function tagMatchesVersion(tag: string, version: string): boolean {
  const strip = (value: string) => value.trim().replace(/^v/i, "");
  return strip(tag) === strip(version);
}
