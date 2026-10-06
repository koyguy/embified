import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { clearSessionCookie, sessionCookieValue } from './auth.ts';
import { marketingRedirectTarget, registerMarketingRedirects } from './public-site.ts';
import {
  configureProxyTrust,
  httpsRedirect,
  isHttpExempt,
  isLoopback,
  normalizeOrigin,
  publicHttpsUrl,
  resetTunnelCache,
} from './tunnel.ts';

describe('tunnel url helpers', () => {
  it('accepts only bare https origins', () => {
    assert.equal(normalizeOrigin('https://abc-def.trycloudflare.com\n'), 'https://abc-def.trycloudflare.com');
    assert.equal(normalizeOrigin('https://Vault.Example.com/'), 'https://vault.example.com');
    assert.equal(normalizeOrigin('http://abc.trycloudflare.com'), null);
    assert.equal(normalizeOrigin('https://abc.trycloudflare.com/x'), null);
    assert.equal(normalizeOrigin('https://evil.com@abc.trycloudflare.com'), null);
    assert.equal(normalizeOrigin('javascript:alert(1)'), null);
    assert.equal(normalizeOrigin(''), null);
  });

  it('reads the url file, prefers EMBIFIED_PUBLIC_URL, null when missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tun-'));
    const file = path.join(dir, 'tunnel-url.txt');
    resetTunnelCache();
    assert.equal(publicHttpsUrl({ EMBIFIED_TUNNEL_URL_FILE: file }), null);
    fs.writeFileSync(file, 'https://one-two.trycloudflare.com\n');
    resetTunnelCache();
    assert.equal(publicHttpsUrl({ EMBIFIED_TUNNEL_URL_FILE: file }), 'https://one-two.trycloudflare.com');
    assert.equal(
      publicHttpsUrl({ EMBIFIED_TUNNEL_URL_FILE: file, EMBIFIED_PUBLIC_URL: 'https://vault.example.com' }),
      'https://vault.example.com'
    );
    fs.writeFileSync(file, 'garbage');
    resetTunnelCache();
    assert.equal(publicHttpsUrl({ EMBIFIED_TUNNEL_URL_FILE: file }), null);
    fs.rmSync(dir, { recursive: true, force: true });
    resetTunnelCache();
  });

  it('classifies loopback and exempt paths', () => {
    assert.ok(isLoopback('127.0.0.1'));
    assert.ok(isLoopback('::ffff:127.0.0.1'));
    assert.ok(isLoopback('::1'));
    assert.ok(!isLoopback('144.24.138.220'));
    assert.ok(!isLoopback(undefined));
    for (const p of ['/health', '/api/digest/health', '/api/whatsapp/webhook', '/public/login.css']) assert.ok(isHttpExempt(p));
    for (const p of ['/', '/login', '/api/groups', '/auth/login', '/assets/x.js']) assert.ok(!isHttpExempt(p));
  });

  it('adds Secure to the session cookie only for https requests', () => {
    assert.ok(!sessionCookieValue('t').includes('Secure'));
    assert.ok(sessionCookieValue('t', true).endsWith('; Secure'));
    assert.ok(!clearSessionCookie().includes('Secure'));
    assert.ok(clearSessionCookie(true).includes('Secure'));
  });
});

/** Raw request so we can set Host / X-Forwarded-Proto and read Location without following redirects. */
function req(port: number, method: string, p: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, location: res.headers.location, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('https redirect middleware', () => {
  let server: http.Server;
  let port: number;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tun-mw-'));
  const file = path.join(dir, 'tunnel-url.txt');
  const prev = process.env.EMBIFIED_TUNNEL_URL_FILE;

  before(async () => {
    process.env.EMBIFIED_TUNNEL_URL_FILE = file;
    fs.writeFileSync(file, 'https://abc-xyz.trycloudflare.com\n');
    resetTunnelCache();
    const app = express();
    // Test sockets all come from 127.0.0.1; x-test-external rewrites the peer address to look external.
    configureProxyTrust(app, { EMBIFIED_TRUST_PROXY: 'loopback' });
    app.use((r, _res, next) => {
      if (r.headers['x-test-external']) Object.defineProperty(r.socket, 'remoteAddress', { value: '203.0.113.9', configurable: true });
      next();
    });
    app.use(httpsRedirect((p) => marketingRedirectTarget(p) !== null));
    registerMarketingRedirects(app);
    app.get('*', (r, res) => res.json({ secure: r.secure, path: r.path }));
    app.post('*', (_r, res) => res.json({ ok: true }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = (server.address() as AddressInfo).port;
  });

  after(() => {
    server.close();
    if (prev === undefined) delete process.env.EMBIFIED_TUNNEL_URL_FILE;
    else process.env.EMBIFIED_TUNNEL_URL_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    resetTunnelCache();
  });

  const ext = { 'x-test-external': '1' };

  it('redirects external plain http to the tunnel, keeping path + query', async () => {
    const r = await req(port, 'GET', '/login?next=%2F', ext);
    assert.equal(r.status, 302);
    assert.equal(r.location, 'https://abc-xyz.trycloudflare.com/login?next=%2F');
    assert.equal((await req(port, 'GET', '/', ext)).location, 'https://abc-xyz.trycloudflare.com/');
    assert.equal((await req(port, 'GET', '/api/groups', ext)).status, 302);
    const post = await req(port, 'POST', '/auth/login', ext);
    assert.equal(post.status, 307);
  });

  it('keeps monitors, webhook and marketing 301s on http', async () => {
    assert.equal((await req(port, 'GET', '/health', ext)).status, 200);
    assert.equal((await req(port, 'GET', '/api/digest/health', ext)).status, 200);
    assert.equal((await req(port, 'GET', '/api/whatsapp/webhook?hub.mode=x', ext)).status, 200);
    const m = await req(port, 'GET', '/start?ref=a', ext);
    assert.equal(m.status, 301);
    assert.ok(m.location?.startsWith('https://koyguy.github.io/embified/'));
  });

  it('does not loop for tunnel traffic and leaves local http alone', async () => {
    // cloudflared → 127.0.0.1 with X-Forwarded-Proto: https → trusted → secure, served directly.
    const t = await req(port, 'GET', '/login', { 'x-forwarded-proto': 'https', 'cf-ray': 'abc' });
    assert.equal(t.status, 200);
    assert.equal(JSON.parse(t.body).secure, true);
    // Local curl over http (loopback, no proxy headers).
    const l = await req(port, 'GET', '/login');
    assert.equal(l.status, 200);
    assert.equal(JSON.parse(l.body).secure, false);
  });

  it('ignores spoofed X-Forwarded-Proto from outside', async () => {
    const r = await req(port, 'GET', '/login', { ...ext, 'x-forwarded-proto': 'https' });
    // req.secure is evaluated lazily against the (shimmed) non-loopback peer, so the header is not trusted.
    assert.equal(r.status, 302);
  });

  it('serves directly when no tunnel URL is known', async () => {
    fs.rmSync(file, { force: true });
    resetTunnelCache();
    assert.equal((await req(port, 'GET', '/login', ext)).status, 200);
  });
});
