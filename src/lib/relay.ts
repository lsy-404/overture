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

// Every Cloudflare call goes through this deployment's own Worker routes
// (`/cf/*`, `/r2/verify-keys`, `/github/release-asset`): api.cloudflare.com
// sends no CORS headers, so a direct browser call fails regardless of whether
// the token is valid. The relay allow-lists paths — an endpoint nobody listed
// on purpose is refused there, not here.

import { sourceSlug, type SourceRef } from "../../shared/package";

export class CfApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly context?: string,
  ) {
    super(message);
    this.name = "CfApiError";
  }
}

// Empty (the default) means same-origin relative calls — the Worker serves both
// the built frontend and these routes. Only set VITE_RELAY_URL when the frontend
// is deployed separately from the Worker it talks to.
function relayBase(): string {
  const url = (import.meta.env.VITE_RELAY_URL || "").trim();
  return url.replace(/\/+$/, "");
}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

// A network-level failure (relay unreachable, DNS, TLS, offline) surfaces from
// fetch() as a bare `TypeError: Failed to fetch` with no further detail. Naming
// the relay turns that dead end into something actionable.
async function fetchRelay(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new CfApiError(
      `Couldn't reach the deploy relay at ${url.replace(/\/(cf|r2|github)\/.*$/, "")} — check your connection or that the relay is deployed.`,
      0,
    );
  }
}

/**
 * Streams a release asset through the relay. `src` travels with the request
 * because the relay re-checks two things independently: that the URL really is
 * a release download of that repository, and that the repository passes the
 * operator's deploy policy.
 */
export async function fetchGithubReleaseAsset(url: string, ref: SourceRef): Promise<Response> {
  const query = `src=${encodeURIComponent(sourceSlug(ref))}&url=${encodeURIComponent(url)}`;
  return fetchRelay(`${relayBase()}/github/release-asset?${query}`, {
    headers: { Accept: "application/octet-stream" },
  });
}

/**
 * Calls `/cf/<path>` with the given bearer token. `token` isn't always the
 * account API token — the asset-upload completion call reuses this helper with
 * the short-lived JWT the upload session returns, since the relay forwards
 * whatever bearer it is handed.
 */
export async function callCfJson<T>(
  token: string,
  path: string,
  init?: RequestInit,
  context?: string,
): Promise<T> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  let body: CfEnvelope<T>;
  try {
    body = (await response.json()) as CfEnvelope<T>;
  } catch {
    throw new CfApiError(`Cloudflare returned a non-JSON response (HTTP ${response.status})`, response.status, undefined, context);
  }
  if (!response.ok || !body.success) {
    const first = body.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
  return body.result as T;
}

/** Script deletion answers with an empty body, which `response.json()` can't parse. */
export async function callCfNoContent(token: string, path: string, init?: RequestInit, context?: string): Promise<void> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  const text = (await response.text()).trim();
  let body: CfEnvelope<unknown> | undefined;
  if (text) {
    try {
      body = JSON.parse(text) as CfEnvelope<unknown>;
    } catch {
      body = undefined;
    }
  }
  if (!response.ok || body?.success === false) {
    const first = body?.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
}

/** Multipart variant for the Worker version upload and the asset-upload completion call. */
export async function callCfMultipart<T>(
  token: string,
  path: string,
  form: FormData,
  context?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal,
  });
  let body: CfEnvelope<T>;
  try {
    body = (await response.json()) as CfEnvelope<T>;
  } catch {
    throw new CfApiError(`Cloudflare returned a non-JSON response (HTTP ${response.status})`, response.status, undefined, context);
  }
  if (!response.ok || !body.success) {
    const first = body.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
  return body.result as T;
}

export interface R2VerifyParams {
  accountId: string;
  bucketName?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2VerifyResult {
  ok: boolean;
  status?: number;
  message?: string;
}

/** The relay signs a HEAD against R2 itself; this never touches api.cloudflare.com. */
export async function verifyR2Keys(params: R2VerifyParams): Promise<R2VerifyResult> {
  const base = relayBase();
  let response: Response;
  try {
    response = await fetch(`${base}/r2/verify-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch {
    return { ok: false, message: `Couldn't reach the deploy relay at ${base} — check your connection or that the relay is deployed.` };
  }
  try {
    return (await response.json()) as R2VerifyResult;
  } catch {
    return { ok: false, status: response.status, message: "The relay returned a non-JSON response" };
  }
}
