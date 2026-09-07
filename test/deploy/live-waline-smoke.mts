import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createCapabilityHost } from '../../src/lib/engine/capabilities';
import { enableWorkersDevUrl } from '../../src/lib/deploy/workersDev';
import { validateRecipe } from '../../src/lib/recipe/schema';
import { unpackArtifact } from '../../src/lib/package/tar';

const account = process.env.CLOUDFLARE_ACCOUNT_ID!;
const token = process.env.CLOUDFLARE_API_TOKEN!;
const directory = process.env.WALINE_PACKAGE_DIRECTORY!;
assert.ok(account && token && directory, 'Set account, API token, and package directory for this live test');
const parsed = validateRecipe(JSON.parse(await readFile(`${directory}/overture.json`, 'utf8')));
assert.ok(parsed.ok);
const recipe = parsed.recipe;
const bytes = await readFile(`${directory}/overture.tar.gz`);
assert.equal(createHash('sha256').update(bytes).digest('hex'), recipe.package.sha256);
const files = await unpackArtifact(bytes);
assert.equal(new TextDecoder().decode(files.get('recipe.js')), await readFile(`${directory}/package/recipe.js`, 'utf8'));
const workerName = `waline-smoke-${randomUUID().slice(0, 8)}`;
const databaseName = `${workerName}-db`;
const prefix = `/accounts/${account}`;
const nativeFetch = globalThis.fetch;
let databaseId = '';
let uploaded = false;
const cf = (path: string, init?: RequestInit) => nativeFetch(`https://api.cloudflare.com/client/v4${path}`, {
  ...init,
  headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${token}` },
});
globalThis.fetch = async (input, init) => {
  const relative = String(input);
  assert.ok(relative.startsWith(`/cf${prefix}/`), 'Only the selected account may be changed');
  const path = relative.slice(3);
  const response = await cf(path, init);
  if (path === `${prefix}/d1/database` && init?.method === 'POST' && response.ok) {
    databaseId = (await response.clone().json() as any).result.uuid;
  }
  if (path === `${prefix}/workers/scripts/${workerName}/versions` && init?.method === 'POST' && response.ok) uploaded = true;
  if (path === `${prefix}/workers/scripts/${workerName}` && init?.method === 'PUT' && response.ok) uploaded = true;
  return response;
};
try {
  const { deploy } = await import(pathToFileURL(`${directory}/package/recipe.js`).href);
  const deployCase = async (mode: 'fresh' | 'overwrite', fullRebuild = false) => {
  const live = { exists: mode === 'overwrite', vars: {}, crons: [], customDomains: [], containerClasses: [] };
  const target = { mode, workerName, resourceNames: { db: databaseName }, adopted: databaseId ? { db: { id: databaseId, name: databaseName } } : {}, inputs: { secure_domains: '' }, declareContainers: [], fullRebuild, domain: '' };
  const host = createCapabilityHost({
    pkg: { recipe, files, tag: recipe.tag },
    creds: { accountId: account, cfApiToken: '', r2AccessKeyId: '', r2SecretAccessKey: '' },
    target, live, deploymentUuid: randomUUID(), onStep: () => {}, onProgress: () => {},
  });
  const guest: any = {
    ctx: { ...target, live, recipe, tag: recipe.tag, version: recipe.version, locale: 'zh-CN' },
    step: (...args: unknown[]) => host.invoke('step.set', args),
    text: (...args: unknown[]) => host.invoke('pkg.text', args),
    result: (...args: unknown[]) => host.invoke('result.set', args),
  };
  for (const group of ['d1', 'worker', 'domains', 'secrets', 'crypto']) {
    guest[group] = new Proxy({}, { get: (_, method) => (...args: unknown[]) => host.invoke(`${group}.${String(method)}`, args) });
  }
  await deploy(guest);
  assert.ok(host.activeVersionId());
  assert.equal(host.result().url, '');
  return enableWorkersDevUrl(account, workerName, 'zh-CN');
  };
  const url = await deployCase('fresh');
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    ready = await nativeFetch(url).then(response => response.ok, () => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Worker did not become reachable');
  const identity = { email: 'smoke@example.invalid', password: randomUUID() };
  const post = (path: string, body: unknown, bearer?: string) => nativeFetch(`${url}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post('/api/user', identity)).status, 201);
  const login = await post('/api/token', identity);
  assert.equal(login.status, 200);
  const session = (await login.json() as any).data.token;
  assert.ok(session);
  const comment = await post('/api/comment', { comment: 'Deployment smoke check', url: '/smoke' }, session);
  assert.ok(comment.ok);
  assert.equal((await comment.json() as any).errno, 0);
  console.log('PASS live no-domain deployment: D1, Worker, JWT, workers.dev reachability, registration, login, comment');
  await deployCase('overwrite');
  const sessionStatus = () => nativeFetch(`${url}/api/token`, { headers: { Authorization: `Bearer ${session}` } });
  assert.equal((await sessionStatus()).status, 200);
  console.log('PASS live overwrite: existing login session preserved');
  await deployCase('overwrite', true);
  let rebuiltStatus = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    rebuiltStatus = await sessionStatus().then(response => response.status, () => 0);
    if (rebuiltStatus === 401) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(rebuiltStatus, 401);
  assert.equal((await post('/api/token', identity)).status, 200);
  const dataCheck = await cf(`${prefix}/d1/database/${databaseId}/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT COUNT(*) AS count FROM wl_Comment' }),
  });
  assert.equal((await dataCheck.json() as any).result[0].results[0].count, 1);
  console.log('PASS live full rebuild: data retained, old session invalidated, login restored');
} finally {
  globalThis.fetch = nativeFetch;
  const cleanup = await Promise.allSettled([
    ...(uploaded ? [cf(`${prefix}/workers/scripts/${workerName}`, { method: 'DELETE' }).then(response => assert.ok(response.ok || response.status === 404, 'Temporary Worker cleanup failed'))] : []),
    ...(databaseId ? [cf(`${prefix}/d1/database/${databaseId}`, { method: 'DELETE' }).then(response => assert.ok(response.ok, 'Temporary database cleanup failed'))] : []),
  ]);
  assert.ok(cleanup.every(result => result.status === 'fulfilled'), 'Temporary resource cleanup failed');
  console.log('Temporary resources cleaned up');
}
