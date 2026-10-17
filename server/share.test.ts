import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';

// store/shares read DATA_DIR at import/call time: point at a temp vault first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embified-share-'));
process.env.DATA_DIR = dir;
process.env.EMBIFIED_AUTH_PASSWORD = 'owner-pass';
delete process.env.EMBIFIED_AUTH_SECURE;

let store: typeof import('./store.ts');
let shares: typeof import('./shares.ts');
let auth: typeof import('./auth.ts');
let routes: typeof import('./share-routes.ts');

const A = '120363000000000001@g.us';
const B = '120363000000000002@g.us';
const C = '120363000000000003@g.us'; // not shared

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
let mediaA = '';
let mediaC = '';

before(async () => {
  store = await import('./store.ts');
  shares = await import('./shares.ts');
  auth = await import('./auth.ts');
  routes = await import('./share-routes.ts');

  for (const [id, name] of [[A, 'Embifi - 2W'], [B, 'Embifi - 2W Operating Member Group'], [C, 'Family']] as const) {
    store.upsertGroup({ id, name, kind: 'group' });
  }
  const ma = store.saveMedia(Buffer.from('img-a'), 'image/png', 'a.png');
  const mc = store.saveMedia(Buffer.from('img-c'), 'image/png', 'c.png');
  mediaA = ma.url;
  mediaC = mc.url;
  const msg = (g: string, id: string, extra = {}) => ({
    id, groupId: g, from: '91', authorName: 'X', text: `t-${id}`, fromMe: false, timestamp: new Date().toISOString(), ...extra,
  });
  store.appendMessage(msg(A, 'a1', { media: [ma] }));
  store.appendMessage(msg(B, 'b1'));
  store.appendMessage(msg(C, 'c1', { media: [mc] }));

  // Mirror server.ts wiring: share link before the wall, guard right after it, owner-only routes after.
  const app = express();
  app.use(express.json());
  app.post('/auth/login', (_req, res) => {
    res.setHeader('Set-Cookie', auth.sessionCookieValue(auth.signSession()));
    res.end();
  });
  routes.registerShareLink(app);
  app.use(auth.requireAuth);
  app.use(routes.shareScopeGuard);
  routes.registerInboxRoutes(app);
  const owner = (_req: express.Request, res: express.Response) => res.json({ owner: true });
  for (const p of ['/api/status', '/api/cloud-config', '/api/disk', '/api/digest', '/api/history/status', '/api/funnel/stats']) app.get(p, owner);
  for (const p of ['/api/provider', '/api/cloud-config', '/api/whatsapp/reset', '/api/history/backfill']) app.post(p, owner);
  app.get('/', (_req, res) => res.send('spa'));
  await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (p: string, cookie = '', init: RequestInit = {}) =>
  fetch(base + p, { redirect: 'manual', ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers || {}) } });

async function openShare(token: string) {
  const r = await get(`/s/${token}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  const sc = r.headers.get('set-cookie') || '';
  assert.match(sc, /^embified_share=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  return sc.split(';')[0];
}

describe('share store', () => {
  it('stores only a sha256 of a 256-bit token', () => {
    const { share, token } = shares.createShare({ label: 'x', groupIds: [A] });
    assert.ok(token && token.length >= 43);
    const raw = fs.readFileSync(shares.sharesFile(), 'utf8');
    assert.ok(!raw.includes(token!), 'plaintext token must not be stored');
    assert.equal(share.tokenHash, shares.hashToken(token!));
    shares.revokeShare(share.id);
  });
  it('redacts share tokens from logged paths', () => {
    assert.equal(shares.redactSharePath('/s/abcDEF_123-xyz?x=1'), '/s/[redacted]?x=1');
  });
});

describe('scoped team session', () => {
  let cookie = '';
  let shareId = '';
  let token = '';

  before(async () => {
    const out = shares.createShare({ label: 'Embifi 2W team', groupIds: [A, B] });
    shareId = out.share.id;
    token = out.token!;
    cookie = await openShare(token);
  });

  it('rejects unknown tokens', async () => {
    assert.equal((await get(`/s/${'x'.repeat(43)}`)).status, 404);
    assert.equal((await get('/api/groups')).status, 401);
  });

  it('identifies itself as a read-only share', async () => {
    const d = await (await get('/api/share/me', cookie)).json();
    assert.deepEqual(d, { role: 'share', id: shareId, label: 'Embifi 2W team', readOnly: true });
  });

  it('lists exactly the allowed groups', async () => {
    const d = await (await get('/api/groups', cookie)).json();
    assert.deepEqual(d.groups.map((g: any) => g.id).sort(), [A, B].sort());
  });

  it('reads allowed messages and media, not other groups', async () => {
    const a = await get(`/api/groups/${encodeURIComponent(A)}/messages`, cookie);
    assert.equal(a.status, 200);
    assert.equal((await a.json()).messages[0].text, 't-a1');
    assert.equal((await get(`/api/groups/${encodeURIComponent(C)}/messages`, cookie)).status, 404);
    assert.equal((await get(`/api/groups/${C}/messages`, cookie)).status, 404);
    const ma = await get(mediaA, cookie);
    assert.equal(ma.status, 200);
    assert.equal(await ma.text(), 'img-a');
    assert.equal((await get(mediaC, cookie)).status, 404);
    assert.equal((await get('/media/../groups.json', cookie)).status, 404);
    assert.equal((await get('/media/%2e%2e%2fgroups.json', cookie)).status, 404);
  });

  it('cannot reach settings, link controls, digest, backfill or funnel', async () => {
    for (const p of ['/api/status', '/api/cloud-config', '/api/disk', '/api/digest', '/api/history/status', '/api/funnel/stats', '/api/nope']) {
      assert.equal((await get(p, cookie)).status, 403, p);
    }
    for (const p of ['/api/provider', '/api/cloud-config', '/api/whatsapp/reset', '/api/history/backfill', `/api/groups/${encodeURIComponent(A)}/read`]) {
      assert.equal((await get(p, cookie, { method: 'POST' })).status, 403, p);
    }
  });

  it('does not clear the owner unread badge', async () => {
    const before = store.listGroups().find((g) => g.id === A)!.unread;
    await get(`/api/groups/${encodeURIComponent(A)}/messages`, cookie);
    assert.equal(store.listGroups().find((g) => g.id === A)!.unread, before);
  });

  it('a forged or tampered cookie gets nothing', async () => {
    const bad = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal((await get('/api/groups', bad)).status, 401);
  });

  it('revoking stops the link and existing sessions immediately', async () => {
    shares.revokeShare(shareId);
    assert.equal((await get('/api/groups', cookie)).status, 401);
    assert.equal((await get(mediaA, cookie)).status, 401);
    assert.equal((await get(`/api/groups/${encodeURIComponent(A)}/messages`, cookie)).status, 401);
    assert.equal((await get(`/s/${token}`)).status, 404);
  });
});

describe('owner session', () => {
  it('keeps full access', async () => {
    const r = await fetch(base + '/auth/login', { method: 'POST' });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    const d = await (await get('/api/groups', cookie)).json();
    assert.equal(d.groups.length, 3);
    assert.equal((await get(`/api/groups/${encodeURIComponent(C)}/messages`, cookie)).status, 200);
    assert.equal((await get(mediaC, cookie)).status, 200);
    assert.equal((await get('/api/status', cookie)).status, 200);
    assert.deepEqual(await (await get('/api/share/me', cookie)).json(), { role: 'owner' });
  });
});
