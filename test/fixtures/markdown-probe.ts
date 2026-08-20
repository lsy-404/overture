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

// See markdown-probe.html. renderMarkdown() is the only place in the app that
// touches v-html, and its input is a recipe author's own text — trusted enough
// to run recipe.js in the sandbox, not trusted enough to inject markup into the
// host page. DOMPurify's behaviour depends on the real HTML parser, which is
// exactly what a jsdom-backed unit test would not be trusted to reproduce
// faithfully — this runs the shipping code in a real browser instead.

import { renderMarkdown } from "../../src/lib/markdown";

const out = document.getElementById("out") as HTMLElement;
let failures = 0;
out.textContent = "";
function say(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  out.textContent += `${ok ? "PASS  " : "FAIL  "}${name}${detail ? `   ${detail}` : ""}\n`;
}

/** Renders into a detached element so assertions read the real parsed DOM. */
function toDom(markdown: string): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(markdown);
  return el;
}

// --- ordinary content renders as real elements -------------------------------

const doc = toDom("# Title\n\n## Section\n\nSome **bold** and *emphasis* text.\n\n- one\n- two\n\n[a link](https://example.com/x)");
say("h1 renders", doc.querySelector("h1")?.textContent === "Title", doc.innerHTML);
say("h2 renders", doc.querySelector("h2")?.textContent === "Section", doc.innerHTML);
say("bold renders as an element, not literal **", !!doc.querySelector("strong"), doc.innerHTML);
say("emphasis renders as an element, not literal *", !!doc.querySelector("em"), doc.innerHTML);
say("a list renders with two items", doc.querySelectorAll("ul li").length === 2, doc.innerHTML);

// --- links are safe and open away from this tab -------------------------------

const link = doc.querySelector("a");
say("a safe https link is kept", link?.getAttribute("href") === "https://example.com/x", String(link?.outerHTML));
say("it opens in a new tab", link?.getAttribute("target") === "_blank", String(link?.outerHTML));
say("noopener is set so the new tab can't reach back in", (link?.getAttribute("rel") || "").includes("noopener"), String(link?.outerHTML));

// --- raw HTML in the source text never becomes a live element -----------------

const rawScript = toDom('Before <script>window.__markdownProbeInjected = true;</script> after');
say("a raw <script> tag in markdown source does not execute", (window as unknown as { __markdownProbeInjected?: boolean }).__markdownProbeInjected !== true, rawScript.innerHTML);
say("a raw <script> tag does not survive as an element either", !rawScript.querySelector("script"), rawScript.innerHTML);

const rawOnerror = toDom('<img src="x" onerror="window.__markdownProbeInjected = true">');
say("a raw onerror handler is neutralised, event never fires", (window as unknown as { __markdownProbeInjected?: boolean }).__markdownProbeInjected !== true, rawOnerror.innerHTML);
say("img is not in the allowed tag set at all", !rawOnerror.querySelector("img"), rawOnerror.innerHTML);

// --- dangerous URI schemes reachable only through markdown's own link syntax --

const jsLink = toDom("[click me](javascript:window.__markdownProbeInjected=true)");
const jsHref = jsLink.querySelector("a")?.getAttribute("href") || "";
say("a javascript: URL is stripped from a markdown-syntax link", !jsHref.toLowerCase().startsWith("javascript:"), jsLink.innerHTML);

const dataLink = toDom("[click me](data:text/html,<script>window.__markdownProbeInjected=true</script>)");
const dataHref = dataLink.querySelector("a")?.getAttribute("href") || "";
say("a data: URL is stripped from a markdown-syntax link", !dataHref.toLowerCase().startsWith("data:"), dataLink.innerHTML);

// --- markdown image syntax also cannot smuggle a tag DOMPurify would allow ----

const imgSyntax = toDom('![alt](https://example.com/x.png "t")');
say("markdown image syntax does not produce a live <img>", !imgSyntax.querySelector("img"), imgSyntax.innerHTML);

// --- a realistic multi-section document, shaped like a recipe's own terms ----

const REALISTIC = [
  "# Terms of Service",
  "",
  "## Data handling",
  "",
  "- Your Cloudflare credentials stay in the current browser tab only.",
  "- Nothing here is logged.",
  "",
  "## Availability",
  "",
  "Provided as-is, with no uptime guarantee. See the [licence](https://example.com/license) for details.",
].join("\n");
const realistic = toDom(REALISTIC);
say("a realistic multi-section document renders two headings", realistic.querySelectorAll("h1, h2").length === 3, realistic.innerHTML);
say("its bullet list renders with two items", realistic.querySelectorAll("li").length === 2, realistic.innerHTML);
say("its inline link still gets the safety attributes", realistic.querySelector("a")?.getAttribute("rel")?.includes("noopener") === true, realistic.innerHTML);

out.textContent += `\n${failures === 0 ? "all probes passed" : `${failures} probe(s) failed`}\n`;
document.title = failures === 0 ? "probe: ok" : `probe: ${failures} failed`;
