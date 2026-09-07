// SPDX-License-Identifier: AGPL-3.0-or-later

import { callCfJson } from "../relay";

const CONTEXT = "Workers Scripts Write";

interface ScriptSubdomain {
  enabled?: boolean;
}

interface AccountSubdomain {
  subdomain?: string;
}

// Resolve the account hostname before enabling the Worker's default route.
export async function enableWorkersDevUrl(accountId: string, script: string, locale: string, signal?: AbortSignal): Promise<string> {
  const encodedScript = encodeURIComponent(script);
  const scriptPath = `/accounts/${accountId}/workers/scripts/${encodedScript}/subdomain`;
  const init = signal ? { signal } : undefined;
  const account = await callCfJson<AccountSubdomain>(`/accounts/${accountId}/workers/subdomain`, init, CONTEXT);
  const subdomain = account.subdomain?.trim().toLowerCase();
  if (!subdomain) {
    throw new Error(locale.startsWith("zh")
      ? "此账户尚未启用 workers.dev 子域名。请在 Cloudflare Workers 设置中启用后重新部署。"
      : "This account has no workers.dev subdomain. Enable it in Cloudflare Workers settings, then deploy again.");
  }
  const current = await callCfJson<ScriptSubdomain>(scriptPath, init, CONTEXT);
  if (!current.enabled) {
    await callCfJson<ScriptSubdomain>(
      scriptPath,
      { method: "POST", body: JSON.stringify({ enabled: true }), signal },
      CONTEXT,
    );
  }
  return `https://${script}.${subdomain}.workers.dev`;
}
