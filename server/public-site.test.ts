import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { isPublicPath, requireAuth } from './auth.ts';
import {
  DEFAULT_PUBLIC_SITE_URL,
  marketingRedirectTarget,
  publicSiteUrl,
  registerMarketingRedirects,
  rewriteLoginHtml,
} from './public-site.ts';

describe('public site config', () => {
  it('defaults to GitHub Pages and accepts an override', () => {
    assert.equal(DEFAULT_PUBLIC_SITE_URL, 'https://koyguy.github.io/embified');
    assert.equal(publicSiteUrl({}), DEFAULT_PUBLIC_SITE_URL);
    assert.equal(publicSiteUrl({ PUBLIC_SITE_URL: 'https://embified.example/' }), 'https://embified.example');
    assert.equal(publicSiteUrl({ PUBLIC_SITE_URL: 'javascript:alert(1)' }), DEFAULT_PUBLIC_SITE_URL);
    assert.equal(publicSiteUrl({ PUBLIC_SITE_URL: 'https://x.example/"><script>' }), DEFAULT_PUBLIC_SITE_URL);
  });

  it('maps marketing paths to static pages and keeps the query', () => {
    const b = 'https://s.example';
    assert.equal(marketingRedirectTarget('/start', '', b), 'https://s.example/');
    assert.equal(marketingRedirectTarget('/start', '?ref=abc123', b), 'https://s.example/?ref=abc123');
    assert.equal(marketingRedirectTarget('/vault', '', b), 'https://s.example/');
    assert.equal(marketingRedirectTarget('/create-vault', '', b), 'https://s.example/create-vault.html');
    assert.equal(marketingRedirectTarget('/cloud-setup/', '', b), 'https://s.example/cloud-setup.html');
    assert.equal(marketingRedirectTarget('/home-setup', '?', b), 'https://s.example/home-setup.html');
    assert.equal(marketingRedirectTarget('/login', '', b), null);
    assert.equal(marketingRedirectTarget('/', '', b), null);
  });

  it('rewrites the login "New here?" link only when overridden', () => {
    const html = '<a href="https://koyguy.github.io/embified/">New here?</a>';
    assert.equal(rewriteLoginHtml(html), html);
    assert.equal(rewriteLoginHtml(html, 'https://e.example'), '<a href="https://e.example/">New here?</a>');
  });
});

describe('vault public paths', () => {
  it('keeps login, health, auth, webhooks and digest health public', () => {
    for (const p of ['/health', '/login', '/auth/login', '/auth/logout', '/api/whatsapp/webhook', '/api/digest/health']) {
      assert.equal(isPublicPath(p), true, p);
    }
  });
  it('no longer exposes marketing pages or funnel endpoints', () => {
    for (const p of ['/start', '/vault', '/create-vault', '/cloud-setup', '/home-setup', '/api/funnel/event', '/api/funnel/stats', '/', '/api/groups', '/api/digest']) {
      assert.equal(isPublicPath(p), false, p);
    }
  });
});

describe('vault redirects with the auth wall on', () => {
  let base = '';
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  const saved = { ...process.env };

  before(async () => {
    process.env.EMBIFIED_AUTH_PASSWORD = 'test-password';
    delete process.env.PUBLIC_SITE_URL;
    const app = express();
    app.get('/login', (_req, res) => res.type('html').send('login'));
    registerMarketingRedirects(app);
    app.use(requireAuth);
    app.get('/health', (_req, res) => res.send('ok'));
    app.post('/api/funnel/event', (_req, res) => res.status(204).end());
    app.get('/', (_req, res) => res.send('inbox'));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    process.env = saved;
  });

  const get = (p: string, init: RequestInit = {}) => fetch(base + p, { redirect: 'manual', ...init });

  it('301s every marketing path to GitHub Pages', async () => {
    const cases: Array<[string, string]> = [
      ['/start', 'https://koyguy.github.io/embified/'],
      ['/start?ref=Ab3x', 'https://koyguy.github.io/embified/?ref=Ab3x'],
      ['/vault', 'https://koyguy.github.io/embified/'],
      ['/create-vault', 'https://koyguy.github.io/embified/create-vault.html'],
      ['/cloud-setup', 'https://koyguy.github.io/embified/cloud-setup.html'],
      ['/home-setup', 'https://koyguy.github.io/embified/home-setup.html'],
    ];
    for (const [p, want] of cases) {
      const r = await get(p);
      assert.equal(r.status, 301, p);
      assert.equal(r.headers.get('location'), want, p);
    }
  });

  it('serves login and health, and walls off the rest', async () => {
    assert.equal((await get('/login')).status, 200);
    assert.equal((await get('/health')).status, 200);
    assert.equal((await get('/api/funnel/event', { method: 'POST' })).status, 401);
    const inbox = await get('/');
    assert.equal(inbox.status, 302);
    assert.match(inbox.headers.get('location') || '', /^\/login\?next=/);
  });
});
