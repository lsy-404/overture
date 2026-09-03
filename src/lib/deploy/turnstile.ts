// SPDX-License-Identifier: AGPL-3.0-or-later

import { callCfJson } from "../relay";

const CONTEXT = "Turnstile Write";

export interface TurnstileWidgetInput {
  name: string;
  domains: string[];
  mode: "managed" | "non-interactive" | "invisible";
}

export interface CreatedTurnstileWidget {
  sitekey: string;
  secret: string;
}

/** Creates one widget and accepts only the two values the deployer needs. */
export async function createTurnstileWidget(
  accountId: string,
  input: TurnstileWidgetInput,
  signal?: AbortSignal,
): Promise<CreatedTurnstileWidget> {
  const result = await callCfJson<unknown>(
    `/accounts/${accountId}/challenges/widgets`,
    { method: "POST", body: JSON.stringify(input), signal },
    CONTEXT,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Cloudflare returned an invalid Turnstile widget");
  const widget = result as Record<string, unknown>;
  const sitekey = typeof widget.sitekey === "string" ? widget.sitekey : "";
  const secret = typeof widget.secret === "string" ? widget.secret : "";
  if (!sitekey || sitekey.length > 32) throw new Error("Cloudflare didn't return a Turnstile sitekey");
  if (!secret || secret.length > 4096) throw new Error("Cloudflare didn't return a Turnstile secret");
  return { sitekey, secret };
}
