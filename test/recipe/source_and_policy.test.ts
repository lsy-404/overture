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

// `?src=` and a release body are both attacker-controlled text. These two
// modules decide which repository a package may come from and which URL may be
// fetched for it, so they are tested as pure functions.

import { parseSource, parseSourceLoose, sourceSlug, isReleaseAssetUrl, assetOf, isDeployable, tagMatchesVersion, PACKAGE_ARTIFACT_NAME, PACKAGE_CONFIG_NAME, type GithubRelease } from "../../shared/package";
import { isSourceAllowed, normalizeSourceEntry, parseSourceList, policyFromVars, MAX_POLICY_SOURCES } from "../../shared/policy";
import { readFileSync } from "node:fs";

const ref = { owner: "acme", repo: "widget" };
const download = (owner: string, repo: string, file: string) =>
  `https://github.com/${owner}/${repo}/releases/download/v1.0.0/${file}`;

const release = (assets: Array<{ name: string; url: string }>): GithubRelease => ({
  tag_name: "v1.0.0",
  assets: assets.map(({ name, url }) => ({ name, browser_download_url: url })),
});

const fullRelease = release([
  { name: PACKAGE_ARTIFACT_NAME, url: download("acme", "widget", PACKAGE_ARTIFACT_NAME) },
  { name: PACKAGE_CONFIG_NAME, url: download("acme", "widget", PACKAGE_CONFIG_NAME) },
]);

const policyOf = (sources: string, allowlistEnabled?: string) =>
  policyFromVars({ ALLOWLIST_ENABLED: allowlistEnabled, ALLOWED_SOURCES: sources });
const exampleConfig = readFileSync("wrangler.toml.example", "utf8");
const exampleSources = exampleConfig.match(/^ALLOWED_SOURCES\s*=\s*"([^"]+)"/m)?.[1] || "";

const checks: Array<[string, boolean, string?]> = [
  ["owner/repo parses", (() => {
    const parsed = parseSource("acme/widget");
    return !!parsed && parsed.owner === "acme" && parsed.repo === "widget" && sourceSlug(parsed) === "acme/widget";
  })()],
  ["dots and underscores are legal in a repo name", !!parseSource("acme/my_widget.js")],
  ["surrounding slashes and whitespace are trimmed, not treated as segments",
    !!parseSource("  /acme/widget/  ")],
  ["anything that is not exactly two segments is rejected",
    ["acme", "acme/widget/extra", "acme//widget", "/", "", "   ", "acme/"].every((value) => parseSource(value) === null)],
  ["traversal segments are rejected",
    ["../widget", "acme/..", "acme/.", "../..", "%2e%2e/widget"].every((value) => parseSource(value) === null)],
  ["illegal characters are rejected",
    ["ac me/widget", "acme/wid get", "acme/wid?get", "acme/wid#get", "-acme/widget", "acme:80/widget"].every((value) => parseSource(value) === null)],
  ["a URL is not a source", ["https://github.com/acme/widget", "github.com/acme/widget", "git@github.com:acme/widget"].every((value) => parseSource(value) === null)],

  ["parseSourceLoose still accepts a bare owner/repo",
    (() => { const p = parseSourceLoose("acme/widget"); return !!p && sourceSlug(p) === "acme/widget"; })()],
  ["parseSourceLoose accepts a full GitHub URL, schemeless, www, trailing slash, extra path, and .git",
    ["https://github.com/acme/widget", "github.com/acme/widget", "www.github.com/acme/widget",
      "https://github.com/acme/widget/", "https://github.com/acme/widget/releases/tag/v1.0.0",
      "https://github.com/acme/widget.git"]
      .every((value) => { const p = parseSourceLoose(value); return !!p && sourceSlug(p) === "acme/widget"; })],
  ["parseSourceLoose still enforces owner/repo charset rules on the extracted segments",
    parseSourceLoose("https://github.com/-acme/widget") === null && parseSourceLoose("https://github.com/../widget") === null],
  ["parseSourceLoose rejects a non-GitHub host and the SSH form",
    parseSourceLoose("https://github.com.evil.test/acme/widget") === null
    && parseSourceLoose("https://evil.test/acme/widget") === null
    && parseSourceLoose("git@github.com:acme/widget") === null],
  ["parseSourceLoose rejects garbage without throwing", parseSourceLoose("not a url") === null && parseSourceLoose("") === null],

  ["an asset URL under this source's release downloads is accepted",
    isReleaseAssetUrl(download("acme", "widget", PACKAGE_ARTIFACT_NAME), ref)],
  ["another repository's asset URL is rejected",
    !isReleaseAssetUrl(download("evil", "widget", PACKAGE_ARTIFACT_NAME), ref)
    && !isReleaseAssetUrl(download("acme", "other", PACKAGE_ARTIFACT_NAME), ref)],
  ["another host is rejected, however similar",
    ["https://github.com.evil.test/acme/widget/releases/download/v1/x.tar.gz",
      "https://raw.githubusercontent.com/acme/widget/releases/download/v1/x.tar.gz",
      "https://evil.test/?u=https://github.com/acme/widget/releases/download/v1/x.tar.gz"]
      .every((url) => !isReleaseAssetUrl(url, ref))],
  ["plain http is rejected", !isReleaseAssetUrl("http://github.com/acme/widget/releases/download/v1/x.tar.gz", ref)],
  ["a non-download path on the right repo is rejected",
    !isReleaseAssetUrl("https://github.com/acme/widget/archive/refs/tags/v1.0.0.tar.gz", ref)
    && !isReleaseAssetUrl("https://github.com/acme/widget/releases/tag/v1.0.0", ref)],
  ["garbage is rejected rather than thrown on", !isReleaseAssetUrl("not a url", ref)],

  ["a release is deployable only with both fixed-name assets",
    isDeployable(fullRelease, ref)
    && !isDeployable(release([{ name: PACKAGE_ARTIFACT_NAME, url: download("acme", "widget", PACKAGE_ARTIFACT_NAME) }]), ref)
    && !isDeployable(release([]), ref)],
  ["an asset whose URL points elsewhere is not picked up",
    assetOf(release([{ name: PACKAGE_ARTIFACT_NAME, url: download("evil", "widget", PACKAGE_ARTIFACT_NAME) }]), PACKAGE_ARTIFACT_NAME, ref) === null],
  ["tags compare with only a leading v ignored",
    tagMatchesVersion("v1.0.0", "1.0.0") && tagMatchesVersion("1.0.0", "1.0.0") && !tagMatchesVersion("v1.0.1", "1.0.0")],

  ["with no vars set the allowlist fails closed (on)",
    policyFromVars({}).allowlistEnabled && policyFromVars({}).sources.length === 0],
  ["ALLOWLIST_ENABLED: \"false\" turns the allowlist off",
    !policyOf("", "false").allowlistEnabled],
  ["anything other than the exact string \"false\" leaves the allowlist on",
    policyOf("", "0").allowlistEnabled
    && policyOf("", "no").allowlistEnabled
    && policyOf("", "  ").allowlistEnabled],
  ["a case-insensitive or whitespace-padded \"false\" is still recognised",
    !policyOf("", "FALSE").allowlistEnabled
    && !policyOf("", "False").allowlistEnabled
    && !policyOf("", "  false  ").allowlistEnabled],

  ["illegal entries are dropped",
    policyOf("acme/widget, not-a-source, a/b/c, ../evil, , acme//widget").sources.join(",") === "acme/widget"],
  ["entries are lowercased and de-duplicated",
    policyOf("Acme/Widget, acme/widget, ACME/WIDGET").sources.join(",") === "acme/widget"],
  ["the list is capped at MAX_POLICY_SOURCES",
    policyOf(Array.from({ length: MAX_POLICY_SOURCES + 50 }, (_, i) => `acme/widget${i}`).join(",")).sources.length === MAX_POLICY_SOURCES],

  ["a disabled allowlist allows everything",
    isSourceAllowed(policyOf("", "false"), ref) && isSourceAllowed(policyOf("other/repo", "false"), ref)],
  ["an enabled allowlist admits only listed sources, case-insensitively",
    isSourceAllowed(policyOf("ACME/Widget"), ref)
    && isSourceAllowed(policyOf("acme/widget"), { owner: "AcMe", repo: "WIDGET" })
    && !isSourceAllowed(policyOf("acme/other"), ref)
    && !isSourceAllowed(policyOf(""), ref)],

  ["a var value splits on commas and whitespace and drops junk",
    parseSourceList("Acme/Widget, other/repo\n bad entry\tthird/repo").join(",") === "acme/widget,other/repo,third/repo"],
  ["normalizeSourceEntry returns null instead of a half-cleaned value",
    normalizeSourceEntry("acme/widget") === "acme/widget" && normalizeSourceEntry("acme/wid get") === null],
  ["the public deployment template allows both EdgeSonic and OMEW",
    isSourceAllowed(policyOf(exampleSources), { owner: "wuyilingwei", repo: "edgesonic" })
    && isSourceAllowed(policyOf(exampleSources), { owner: "wuyilingwei", repo: "OMEW" })],
];

let failures = 0;
for (const [label, passed, detail] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`${checks.length - failures}/${checks.length} assertions passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
