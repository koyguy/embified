import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as store from './server/store.ts';
import { getStatus, onEvent, startWhatsApp, switchProvider } from './server/wa.ts';
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
  res.sendFile(path.join(process.cwd(), 'public', 'login.html'));
});

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
  res.setHeader('Set-Cookie', sessionCookieValue(signSession()));
  res.redirect(next);
});

app.post('/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.redirect('/login');
});

app.get('/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
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

app.get('/api/digest', (_req, res) => {
  try {
    const disk = getQuotaBytes();
    const groups = store.listGroups();
    const messageCount = groups.reduce((n, g: any) => n + (Number(g.messageCount) || 0), 0);
    const groupsWithMessages = groups.filter((g: any) => (Number(g.messageCount) || 0) > 0).length;
    res.json({
      ok: true,
      idleShield: readIdleShieldStamp(),
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

app.get('/vault', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'vault.html'));
});

app.get('/create-vault', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'create-vault.html'));
});

app.get('/cloud-setup', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'cloud-setup.html'));
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
