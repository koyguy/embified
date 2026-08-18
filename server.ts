import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as store from './server/store.ts';
import { getStatus, onEvent, startWhatsApp } from './server/wa.ts';

const app = express();
const PORT = Number(process.env.PORT) || 3002;

app.use(express.json({ limit: '2mb' }));
app.use('/media', express.static(store.getMediaDir(), { maxAge: '7d' }));

app.get('/api/status', (_req, res) => {
  res.json(getStatus());
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
    console.log('Scan QR in the app if the business WhatsApp is not linked yet.');
    try {
      await startWhatsApp();
    } catch (e: any) {
      console.error('WhatsApp start failed', e?.message || e);
    }
  });
}

start();
