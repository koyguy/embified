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
  app.use(express.urlencoded({ extended: false }));
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

const form = (pw: string, extra: Record<string, string> = {}) => ({
  method: 'POST',
  body: new URLSearchParams({ password: pw }).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra },
});

describe('password helpers', () => {
  it('stores scrypt hashes, verifies, and rejects bad input', async () => {
    const h = await shares.hashSharePassword('correct horse 42');
    assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.ok(!h.includes('correct'));
    assert.equal(await shares.verifySharePassword('correct horse 42', h), true);
    assert.equal(await shares.verifySharePassword('correct horse 43', h), false);
    assert.equal(await shares.verifySharePassword('', h), false);
    assert.equal(await shares.verifySharePassword('x', 'garbage'), false);
    assert.equal(await shares.verifySharePassword('x', null), false);
    await assert.rejects(shares.hashSharePassword('short'));
    assert.notEqual(await shares.hashSharePassword('correct horse 42'), h, 'fresh salt each time');
  });
  it('generates human-friendly passwords', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = shares.generateSharePassword();
      assert.match(p, /^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
      seen.add(p);
    }
    assert.ok(seen.size > 45);
  });
});

describe('password-protected share', () => {
  let shareId = '';
  let token = '';
  let oldCookie = '';
  const PW = 'maple-river-orbit-42';

  before(async () => {
    const out = shares.createShare({ label: 'Embifi 2W team', groupIds: [A, B] });
    shareId = out.share.id;
    token = out.token!;
    oldCookie = await openShare(token); // opened before a password existed
    assert.equal((await get('/api/groups', oldCookie)).status, 200);
    await shares.setSharePassword(shareId, PW);
    routes.resetAttempts();
  });

  it('stores only a hash and lists the share as protected', () => {
    const raw = fs.readFileSync(shares.sharesFile(), 'utf8');
    assert.ok(!raw.includes(PW));
    assert.ok(shares.getActiveShare(shareId)!.passwordHash!.startsWith('scrypt$'));
  });

  it('invalidates sessions opened before the password was set', async () => {
    assert.equal((await get('/api/groups', oldCookie)).status, 401);
    assert.equal((await get(mediaA, oldCookie)).status, 401);
    assert.equal((await get(`/api/groups/${encodeURIComponent(A)}/messages`, oldCookie)).status, 401);
    const page = await get('/', oldCookie);
    assert.equal(page.status, 401);
    assert.match(await page.text(), /shared view has ended/);
    assert.match(page.headers.get('set-cookie') || '', /^embified_share=; /);
  });

  it('opening the link shows a password page and grants nothing', async () => {
    const r = await get(`/s/${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /type="password"/);
    assert.match(html, /Embifi 2W team/);
    assert.ok(!html.includes(token), 'token must not be echoed into the page');
    // Old session in the browser does not bypass the page either.
    const r2 = await get(`/s/${token}`, oldCookie);
    assert.equal(r2.status, 200);
  });

  it('rejects a wrong password with no session', async () => {
    const r = await get(`/s/${token}`, '', form('wrong-password-1'));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.match(await r.text(), /Wrong password/);
    const empty = await get(`/s/${token}`, '', form(''));
    assert.equal(empty.status, 401);
  });

  it('correct password grants a scoped read-only session', async () => {
    routes.resetAttempts();
    const r = await get(`/s/${token}`, '', form(PW));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/');
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^embified_share=s2\./);
    const d = await (await get('/api/groups', cookie)).json();
    assert.deepEqual(d.groups.map((g: any) => g.id).sort(), [A, B].sort());
    assert.equal((await get(`/api/groups/${encodeURIComponent(C)}/messages`, cookie)).status, 404);
    assert.equal((await get('/api/status', cookie)).status, 403);
    assert.equal((await get(mediaA, cookie)).status, 200);
    // Unlocked browser reopening the link goes straight in.
    const again = await get(`/s/${token}`, cookie);
    assert.equal(again.status, 302);
    assert.equal(again.headers.get('location'), '/');
  });

  it('changing the password signs everyone out; clearing restores link-only access', async () => {
    routes.resetAttempts();
    const r = await get(`/s/${token}`, '', form(PW));
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.equal((await get('/api/groups', cookie)).status, 200);
    await shares.setSharePassword(shareId, 'another-pass-77');
    assert.equal((await get('/api/groups', cookie)).status, 401);
    assert.equal((await get(`/s/${token}`, '', form(PW))).status, 401);
    routes.resetAttempts();
    const ok = await get(`/s/${token}`, '', form('another-pass-77'));
    assert.equal(ok.status, 303);
    shares.clearSharePassword(shareId);
    assert.equal((await get(`/s/${token}`)).status, 302);
    await shares.setSharePassword(shareId, PW);
  });

  it('backs off per share + IP after repeated failures', async () => {
    routes.resetAttempts();
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 4; i++) assert.equal((await get(`/s/${token}`, '', form(`bad-guess-${i}`, ip))).status, 401);
    const fifth = await get(`/s/${token}`, '', form('bad-guess-5', ip));
    assert.equal(fifth.status, 401);
    assert.match(await fifth.text(), /try again in/i);
    // Locked: even the right password waits.
    const locked = await get(`/s/${token}`, '', form(PW, ip));
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal(locked.headers.get('set-cookie'), null);
  });

  it('backoff grows and is keyed by share + client IP', () => {
    routes.resetAttempts();
    const s = shares.getActiveShare(shareId)!;
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) routes.recordFailure(s, '198.51.100.1', t0);
    assert.equal(routes.lockRemaining(s, '198.51.100.1', t0), 30_000);
    routes.recordFailure(s, '198.51.100.1', t0 + 31_000);
    assert.equal(routes.lockRemaining(s, '198.51.100.1', t0 + 31_000), 60_000);
    assert.equal(routes.lockRemaining(s, '198.51.100.2', t0), 0);
    for (let i = 0; i < 30; i++) routes.recordFailure(s, '198.51.100.1', t0 + 40_000);
    assert.equal(routes.lockRemaining(s, '198.51.100.1', t0 + 40_000), 15 * 60_000);
    routes.resetAttempts();
  });

  it('uses Cloudflare client IP only for loopback (tunnel) requests', () => {
    const mk = (remote: string, cf?: string) => ({ socket: { remoteAddress: remote }, headers: cf ? { 'cf-connecting-ip': cf } : {}, ip: remote }) as any;
    assert.equal(routes.clientIp(mk('127.0.0.1', '203.0.113.5')), '203.0.113.5');
    assert.equal(routes.clientIp(mk('198.51.100.7', '203.0.113.5')), '198.51.100.7');
  });

  it('revoking still wins over the password', async () => {
    routes.resetAttempts();
    const r = await get(`/s/${token}`, '', form(PW));
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    shares.revokeShare(shareId);
    assert.equal((await get('/api/groups', cookie)).status, 401);
    assert.equal((await get(`/s/${token}`)).status, 404);
    assert.equal((await get(`/s/${token}`, '', form(PW))).status, 404);
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
