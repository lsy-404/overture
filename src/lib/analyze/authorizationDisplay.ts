// SPDX-License-Identifier: AGPL-3.0-or-later

export interface AuthorizationDisplayRow {
  id: string;
  endpointIds: readonly string[];
}

export const FIXED_AUTHORIZATION_DISPLAY_ROWS: readonly AuthorizationDisplayRow[] = [
  { id: "accountInfo", endpointIds: ["account.read"] },
  { id: "workerTarget", endpointIds: ["worker.scriptList", "worker.scriptRead", "worker.settingsRead", "worker.deploymentList"] },
];

const DEPLOYMENT_AUTHORIZATION_DISPLAY_ROWS: readonly AuthorizationDisplayRow[] = [
  { id: "workersDev", endpointIds: ["worker.subdomainRead", "worker.subdomainEnable", "worker.accountSubdomainRead"] },
  { id: "d1Inventory", endpointIds: ["d1.databaseList"] },
  { id: "r2Inventory", endpointIds: ["r2.bucketList"] },
  { id: "kvInventory", endpointIds: ["kv.namespaceList"] },
  { id: "workerSecrets", endpointIds: ["worker.secretPut"] },
  { id: "containers", endpointIds: ["worker.versionRead", "containers.applicationList", "containers.applicationCreate", "containers.applicationModify", "containers.rolloutCreate"] },
];

/** The package-specific host operations used by this recipe. */
export function deploymentAuthorizationDisplayRows(endpointIds: readonly string[]): AuthorizationDisplayRow[] {
  const endpoints = new Set(endpointIds);
  return DEPLOYMENT_AUTHORIZATION_DISPLAY_ROWS.filter((row) => row.endpointIds.some((id) => endpoints.has(id)));
}
