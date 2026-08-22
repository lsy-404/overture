// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When Cloudflare rejects an otherwise valid `/cf/*` relay request, the relay
 * keeps its own HTTP response successful and records Cloudflare's status here.
 * The browser client uses it for error classification while the JSON envelope
 * retains Cloudflare's original `success: false` and `errors` fields.
 */
export const CF_UPSTREAM_STATUS_HEADER = "X-Overture-Upstream-Status";
