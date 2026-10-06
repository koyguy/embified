import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as store from './server/store.ts';
import { getStatus, onEvent, resetLinkedDevice, startWhatsApp, switchProvider } from './server/wa.ts';
import { readStamp, reconcileReport } from './server/history.ts';
import { readWaState } from './server/wa-state.ts';
import { requestBackfill } from './server/baileys.ts';
import { handleCloudWebhookGet, handleCloudWebhookPost } from './server/cloud.ts';
import { publicConfig, saveCloudFile } from './server/cloud-config.ts';
import type { WaProvider } from './src/types.ts';
import { getQuotaBytes } from './server/disk.ts';
import {
  authEnabled,
  checkPassword,
  clearSessionCookie,
  requireAuth,
  sessionCookieValue,
  signSession,
} from './server/auth.ts';
import { allowRate, appendEvent, readStats, sanitizeEvent } from './server/funnel.ts';
import { marketingRedirectTarget, registerMarketingRedirects, rewriteLoginHtml } from './server/public-site.ts';
import { configureProxyTrust, httpsRedirect, publicHttpsUrl } from './server/tunnel.ts';


import fs from 'fs';

function readIdleShieldStamp() {
  try {
    const stampPath = process.env.EMBIFIED_SHIELD_STAMP || '/var/lib/embified/idle-shield-last.json';
    return JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    return null;
  }
}


const app = express();
const PORT = Number(process.env.PORT) || 3002;

// Cloudflare tunnel → 127.0.0.1: trust its X-Forwarded-Proto so req.secure is true over https.
configureProxyTrust(app);
// Plain http at the public IP → same path on the current https tunnel URL (monitors/webhook/301s exempt).
app.use(httpsRedirect((p) => marketingRedirectTarget(p) !== null));

app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);
app.use('/public', express.static(path.join(process.cwd(), 'public')));

app.use(express.urlencoded({ extended: false }));

app.get('/login', (_req, res) => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'login.html'), 'utf8');
  res.type('html').send(rewriteLoginHtml(html));
});

// Public signup/marketing pages moved to the static site (PUBLIC_SITE_URL, default GitHub Pages).
registerMarketingRedirects(app);

app.post('/auth/login', (req, res) => {
  if (!authEnabled()) {
    res.redirect('/');
    return;
  }
  const password = String(req.body?.password ?? '');
  const next = typeof req.body?.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '/';
  if (!checkPassword(password)) {
    res.redirect('/login?e=1');
    return;
  }
  res.setHeader('Set-Cookie', sessionCookieValue(signSession(), req.secure));
  res.redirect(next);
});

app.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie(req.secure));
  res.redirect('/login');
});

app.get('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie(req.secure));
  res.redirect('/login');
});

app.use(requireAuth);

app.use('/media', express.static(store.getMediaDir(), { maxAge: '7d' }));


app.get('/api/whatsapp/webhook', handleCloudWebhookGet);
app.post('/api/whatsapp/webhook', handleCloudWebhookPost);

app.get('/health', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.get('/api/status', (_req, res) => {
  res.json(getStatus());
});

app.get('/api/cloud-config', (_req, res) => {
  res.json(publicConfig());
});

app.post('/api/cloud-config', async (req, res) => {
  const body = req.body || {};
  const next: Record<string, string> = {};
  if (typeof body.token === 'string' && body.token.trim()) next.token = body.token.trim();
  if (typeof body.phoneNumberId === 'string' && body.phoneNumberId.trim()) {
    next.phoneNumberId = body.phoneNumberId.trim();
  }
  if (typeof body.verifyToken === 'string' && body.verifyToken.trim()) {
    next.verifyToken = body.verifyToken.trim();
  }
  if (typeof body.appSecret === 'string') next.appSecret = body.appSecret.trim();
  if (typeof body.wabaId === 'string') next.wabaId = body.wabaId.trim();
  if (typeof body.webhookPublicUrl === 'string') next.webhookPublicUrl = body.webhookPublicUrl.trim();
  saveCloudFile(next);
  try {
    const status = await switchProvider('cloud');
    res.json({ ok: true, config: publicConfig(), status });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'save failed', config: publicConfig() });
  }
});

app.post('/api/provider', async (req, res) => {
  const provider = req.body?.provider as WaProvider;
  if (provider !== 'baileys' && provider !== 'cloud') {
    res.status(400).json({ error: 'provider must be baileys or cloud' });
    return;
  }
  try {
    const status = await switchProvider(provider);
    res.json({ ok: true, status });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'switch failed' });
  }
});


app.get('/api/disk', (_req, res) => {
  try {
    res.json(getQuotaBytes());
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'disk failed' });
  }
});

/** Link state for monitors: whatsapp = connected | qr | logged_out | disconnected | connecting. */
function whatsappHealth() {
  const st = getStatus();
  if (st.provider === 'cloud') {
    return { provider: 'cloud', whatsapp: st.connected ? 'connected' : 'disconnected', since: null as string | null };
  }
  const rec = readWaState();
  const state = st.connected ? 'connected' : rec?.state || 'connecting';
  return {
    provider: 'baileys',
    whatsapp: state,
    since: rec?.state === state ? rec.since : null,
    lastConnectedAt: rec?.lastConnectedAt ?? null,
    lastLoggedOutAt: rec?.lastLoggedOutAt ?? null,
  };
}

app.get('/api/digest/health', (req, res) => {
  const h = whatsappHealth();
  const stamp = readStamp();
  const ok = h.whatsapp === 'connected';
  // ?strict=1 → 503 when not connected, for monitors that only look at the status code.
  res.status(!ok && req.query.strict ? 503 : 200).json({
    ok,
    ...h,
    lastHistorySyncAt: stamp.lastSyncAt,
    // Current https address (quick tunnel or EMBIFIED_PUBLIC_URL); not secret, null when unknown.
    publicUrl: publicHttpsUrl(),
    generatedAt: new Date().toISOString(),
  });
});

app.get('/api/history/status', (req, res) => {
  const stamp = readStamp();
  const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : stamp.gapStart;
  let reconcile = null;
  try {
    if (since) reconcile = reconcileReport(since);
  } catch {
    res.status(400).json({ error: 'invalid since (use ISO date, e.g. 2026-09-28)' });
    return;
  }
  res.json({ ok: true, whatsapp: whatsappHealth(), stamp, reconcile });
});

app.post('/api/history/backfill', async (req, res) => {
  const since = String(req.body?.since || readStamp().gapStart || '');
  try {
    const results = await requestBackfill({ since, count: req.body?.count, groupId: req.body?.groupId });
    res.json({ ok: true, since, results });
  } catch (e: any) {
    res.status(409).json({ error: e?.message || 'backfill failed' });
  }
});

app.post('/api/whatsapp/reset', async (req, res) => {
  if (!authEnabled()) {
    res.status(403).json({ error: 'Reset requires the auth wall (EMBIFIED_AUTH_PASSWORD) to be enabled' });
    return;
  }
  if (req.body?.confirm !== 'reset') {
    res.status(400).json({ error: 'send {"confirm":"reset"}' });
    return;
  }
  try {
    const out = await resetLinkedDevice({ force: req.body?.force === true });
    res.json({ ok: true, ...out });
  } catch (e: any) {
    res.status(e?.status || 500).json({ error: e?.message || 'reset failed' });
  }
});

app.get('/api/digest', (_req, res) => {
  try {
    const disk = getQuotaBytes();
    const groups = store.listGroups();
    const messageCount = groups.reduce((n, g: any) => n + (Number(g.messageCount) || 0), 0);
    const groupsWithMessages = groups.filter((g: any) => (Number(g.messageCount) || 0) > 0).length;
    res.json({
      ok: true,
      idleShield: readIdleShieldStamp(),
      whatsapp: whatsappHealth(),
      generatedAt: new Date().toISOString(),
      groups: groups.length,
      groupsWithMessages,
      messageCount,
      disk,
      headline: `${groups.length} groups · ${messageCount} messages · ${disk.human.vault} of ${disk.human.quota} vault`,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'digest failed' });
  }
});

// Funnel analytics collector (event + timestamp + random client id, no IP stored).
// Behind the auth wall since the quest moved to the static site; the quest only posts
// events when site/config.js sets ANALYTICS_URL. Kept for operators who want to reuse it.
app.post('/api/funnel/event', (req, res) => {
  const key = String(req.ip || req.socket.remoteAddress || 'unknown');
  if (!allowRate(key)) {
    res.status(429).json({ ok: false });
    return;
  }
  const ev = sanitizeEvent(req.body);
  if (!ev) {
    res.status(400).json({ ok: false });
    return;
  }
  try {
    appendEvent(ev);
  } catch {
    /* analytics must never break the funnel */
  }
  res.status(204).end();
});

// Behind the auth wall: counts per level for the operator.
app.get('/api/funnel/stats', (_req, res) => {
  res.json(readStats());
});

app.get('/api/groups', (_req, res) => {
  res.json({ groups: store.listGroups() });
});

app.get('/api/groups/:id/messages', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const messages = store.loadMessages(id);
  store.markRead(id);
  res.json({ messages });
});

app.post('/api/groups/:id/read', (req, res) => {
  store.markRead(decodeURIComponent(req.params.id));
  res.json({ ok: true, groups: store.listGroups() });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
  res.write(`event: groups\ndata: ${JSON.stringify(store.listGroups())}\n\n`);

  const off = onEvent((event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });

  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    off();
  });
});

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(process.cwd(), 'dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Embified running on http://0.0.0.0:${PORT}`);
    console.log('Choose Linked device (Baileys) or Cloud API in the app.');
    console.log(authEnabled() ? 'Auth wall: ON (EMBIFIED_AUTH_PASSWORD set)' : 'Auth wall: OFF');
    try {
      await startWhatsApp();
    } catch (e: any) {
      console.error('WhatsApp start failed', e?.message || e);
    }
  });
}

start();
