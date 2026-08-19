import crypto from 'crypto';
import type { Request, Response } from 'express';
import pino from 'pino';
import * as store from './store.ts';
import { emit, setStatus } from './bus.ts';
import {
  cloudEnv,
  graphUrl,
  isCloudConfigured,
  missingCloudVars,
} from './cloud-config.ts';
import type { ChatMessage, MediaKind } from '../src/types.ts';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

let active = false;

export function isCloudActive() {
  return active;
}

async function graphGet(path: string) {
  const { token } = cloudEnv();
  const res = await fetch(graphUrl(path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(msg);
  }
  return json;
}

function kindFromType(type: string): MediaKind {
  if (type === 'image') return 'image';
  if (type === 'sticker') return 'sticker';
  if (type === 'video') return 'video';
  if (type === 'audio') return 'audio';
  if (type === 'document') return 'document';
  return 'other';
}

function extractCloudText(message: any): string {
  if (!message) return '';
  if (message.text?.body) return message.text.body;
  if (message.image?.caption) return message.image.caption;
  if (message.video?.caption) return message.video.caption;
  if (message.document?.caption) return message.document.caption;
  if (message.button?.text) return message.button.text;
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.location) {
    const loc = message.location;
    return [loc.name, loc.address, loc.latitude && loc.longitude ? `${loc.latitude},${loc.longitude}` : '']
      .filter(Boolean)
      .join(' — ');
  }
  if (message.contacts?.length) {
    return message.contacts.map((c: any) => c.name?.formatted_name || 'contact').join(', ');
  }
  return '';
}

function extractCloudMedia(message: any): { id: string; kind: MediaKind; mimetype: string; fileName: string } | null {
  const type = message?.type;
  const block = type && message[type];
  if (!block?.id) return null;
  if (!['image', 'video', 'audio', 'document', 'sticker'].includes(type)) return null;
  return {
    id: block.id,
    kind: kindFromType(type),
    mimetype: block.mime_type || 'application/octet-stream',
    fileName: block.filename || `${type}-${block.id}`,
  };
}

async function downloadCloudMedia(mediaId: string, mimetype: string, fileName: string, kind: MediaKind) {
  const { token } = cloudEnv();
  const meta = await graphGet(`/${mediaId}`);
  const url = meta?.url;
  if (!url) throw new Error('No media URL from Graph API');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Media download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return store.saveMedia(buf, meta.mime_type || mimetype, fileName, kind);
}

export function conversationFromMessage(message: any, contacts: any[]) {
  const groupId = message.group_id;
  const from = String(message.from || '');
  const contact = contacts.find((c) => c.wa_id === from) || contacts[0];
  const authorName = contact?.profile?.name || from;
  if (groupId) {
    return {
      id: String(groupId),
      name: `Group ${String(groupId).slice(0, 8)}…`,
      kind: 'group' as const,
      from,
      authorName,
    };
  }
  return {
    id: `dm:${from}`,
    name: authorName || from,
    kind: 'dm' as const,
    from,
    authorName,
  };
}

export async function ingestCloudMessage(message: any, contacts: any[] = [], displayPhone?: string) {
  if (!message?.id) return null;
  if (message.type === 'unsupported') return null;

  const convo = conversationFromMessage(message, contacts);
  store.upsertGroup({ id: convo.id, name: convo.name, kind: convo.kind });

  const text = extractCloudText(message);
  const mediaMeta = extractCloudMedia(message);
  if (!text.trim() && !mediaMeta) return null;

  const media = [];
  if (mediaMeta) {
    try {
      media.push(await downloadCloudMedia(mediaMeta.id, mediaMeta.mimetype, mediaMeta.fileName, mediaMeta.kind));
    } catch (e: any) {
      logger.warn({ err: e?.message, mediaId: mediaMeta.id }, 'cloud media download failed');
    }
  }

  const ts = message.timestamp
    ? new Date(Number(message.timestamp) * 1000).toISOString()
    : new Date().toISOString();
  const fromMe = Boolean(displayPhone && fromDigits(message.from) === fromDigits(displayPhone));

  const saved: ChatMessage = store.appendMessage({
    id: message.id,
    groupId: convo.id,
    from: convo.from,
    authorName: convo.authorName,
    text: text.trim(),
    fromMe,
    timestamp: ts,
    media: media.length ? media : undefined,
  });

  emit('message', saved);
  emit('groups', store.listGroups());
  logger.info(
    { chat: convo.name, author: convo.authorName, preview: (text || `[${mediaMeta?.kind}]`).slice(0, 80) },
    'saved cloud message'
  );
  return saved;
}

function fromDigits(value?: string) {
  return String(value || '').replace(/\D/g, '');
}

export function parseWebhookPayload(body: any) {
  const messages: { message: any; contacts: any[]; displayPhone?: string }[] = [];
  if (body?.object !== 'whatsapp_business_account') return messages;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      const displayPhone = value.metadata?.display_phone_number;
      for (const message of value.messages || []) {
        messages.push({ message, contacts, displayPhone });
      }
      const subject = value.group?.subject || value.subject;
      const groupId = value.group?.id || value.group_id;
      if (groupId && subject) {
        store.upsertGroup({ id: String(groupId), name: subject, kind: 'group' });
        emit('groups', store.listGroups());
      }
    }
  }
  return messages;
}

export async function syncCloudGroups() {
  const { phoneNumberId } = cloudEnv();
  try {
    const json = await graphGet(`/${phoneNumberId}/groups?limit=100`);
    const groups = json?.data?.groups || json?.groups || (Array.isArray(json?.data) ? json.data : []);
    for (const g of groups) {
      if (!g?.id) continue;
      store.upsertGroup({
        id: String(g.id),
        name: g.subject || g.name || String(g.id),
        kind: 'group',
      });
    }
    emit('groups', store.listGroups());
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'cloud group list failed (1:1 chats still work)');
  }
}

export async function startCloud() {
  active = true;
  const missing = missingCloudVars();
  if (missing.length) {
    setStatus({
      connected: false,
      qr: null,
      me: null,
      error: `Cloud API is missing ${missing.join(', ')}. Add them to .env and restart, or switch back to Linked device.`,
      provider: 'cloud',
    });
    return;
  }

  const { phoneNumberId } = cloudEnv();
  try {
    const me = await graphGet(`/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
    setStatus({
      connected: true,
      qr: null,
      me: {
        id: me.display_phone_number || phoneNumberId,
        name: me.verified_name || 'Cloud API',
      },
      error: null,
      provider: 'cloud',
    });
    logger.info({ phone: me.display_phone_number }, 'WhatsApp Cloud API connected');
    await syncCloudGroups();
  } catch (e: any) {
    setStatus({
      connected: false,
      qr: null,
      me: null,
      error: `Cloud API login failed: ${e?.message || e}`,
      provider: 'cloud',
    });
  }
}

export async function stopCloud() {
  active = false;
}

export function verifyCloudSignature(rawBody: Buffer | undefined, header: string | undefined) {
  const { appSecret } = cloudEnv();
  if (!appSecret) return true;
  if (!rawBody || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

export function handleCloudWebhookGet(req: Request, res: Response) {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const { verifyToken } = cloudEnv();
  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  res.status(403).send('Forbidden');
}

export async function handleCloudWebhookPost(req: Request, res: Response) {
  const raw = (req as any).rawBody as Buffer | undefined;
  const sig = req.header('x-hub-signature-256');
  if (!verifyCloudSignature(raw, sig)) {
    res.status(401).send('Invalid signature');
    return;
  }

  res.status(200).json({ ok: true });

  if (!active) return;
  if (!isCloudConfigured()) return;

  try {
    const items = parseWebhookPayload(req.body);
    for (const item of items) {
      await ingestCloudMessage(item.message, item.contacts, item.displayPhone);
    }
  } catch (e: any) {
    logger.error({ err: e?.message }, 'cloud webhook ingest');
  }
}
