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

// Renders a package's own terms/licence text — written by whoever published
// the source repository, not by Overture. Trusted enough to run its recipe.js
// in the sandbox; not trusted enough to inject markup into the host page. Raw
// HTML is off at the parser, the output is sanitised again on the way out, and
// this stays the only place in the app that touches `v-html`.

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

const renderLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer nofollow ugc");
  return renderLinkOpen(tokens, idx, options, env, self);
};

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "strong", "em", "code", "pre",
  "blockquote", "a",
];

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel"],
    // DOMPurify runs every non-inert attribute's value through
    // ALLOWED_URI_REGEXP on the assumption it might be a URI. `target`/`rel`
    // aren't — without this they fail that check silently and vanish.
    ADD_URI_SAFE_ATTR: ["target", "rel"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}
