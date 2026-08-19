import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import * as store from './store.ts';
import { emit, setStatus } from './bus.ts';
import type { ChatMessage, MediaKind } from '../src/types.ts';

const AUTH_DIR = path.resolve(process.env.AUTH_DIR || path.join(process.cwd(), 'auth_info'));
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const silent = pino({ level: 'silent' });

let sock: any = null;
let reconnecting = false;
let stopped = true;

function extractText(msg: any): string {
  const m = msg.message;
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.documentWithCaptionMessage?.message?.documentMessage?.caption) {
    return m.documentWithCaptionMessage.message.documentMessage.caption;
  }
  return '';
}

function detectMedia(msg: any): { kind: MediaKind; mimetype: string; fileName: string } | null {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) {
    return {
      kind: 'image',
      mimetype: m.imageMessage.mimetype || 'image/jpeg',
      fileName: m.imageMessage.fileName || `image-${Date.now()}.jpg`,
    };
  }
  if (m.stickerMessage) {
    return {
      kind: 'sticker',
      mimetype: m.stickerMessage.mimetype || 'image/webp',
      fileName: `sticker-${Date.now()}.webp`,
    };
  }
  if (m.videoMessage) {
    return {
      kind: 'video',
      mimetype: m.videoMessage.mimetype || 'video/mp4',
      fileName: m.videoMessage.fileName || `video-${Date.now()}.mp4`,
    };
  }
  if (m.audioMessage) {
    return {
      kind: 'audio',
      mimetype: m.audioMessage.mimetype || 'audio/ogg',
      fileName: m.audioMessage.ptt ? `voice-${Date.now()}.ogg` : `audio-${Date.now()}.ogg`,
    };
  }
  const doc = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
  if (doc) {
    return {
      kind: 'document',
      mimetype: doc.mimetype || 'application/octet-stream',
      fileName: doc.fileName || doc.title || `document-${Date.now()}`,
    };
  }
  return null;
}

async function handleIncoming(msg: any) {
  if (!msg?.message) return;
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid || isJidStatusBroadcast(remoteJid)) return;
  if (!isJidGroup(remoteJid)) return;

  const groupId = remoteJid;
  let groupName = groupId;
  let memberCount: number | undefined;
  try {
    const meta = await sock.groupMetadata(remoteJid);
    groupName = meta?.subject || groupId;
    memberCount = meta?.participants?.length;
  } catch {
    /* ignore */
  }

  store.upsertGroup({ id: groupId, name: groupName, memberCount, kind: 'group' });

  const text = extractText(msg);
  const mediaMeta = detectMedia(msg);
  if (!text.trim() && !mediaMeta) return;

  const media = [];
  if (mediaMeta) {
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: silent,
        reuploadRequest: sock.updateMediaMessage,
      });
      if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
        media.push(store.saveMedia(buf, mediaMeta.mimetype, mediaMeta.fileName, mediaMeta.kind));
      }
    } catch (e: any) {
      logger.warn({ err: e?.message }, 'media download failed');
    }
  }

  const fromJid = msg.key?.participant || msg.key?.remoteJid;
  const from = fromJid ? jidNormalizedUser(fromJid).split('@')[0] : 'unknown';
  const authorName = msg.pushName || msg.verifiedBizName || from;
  const ts = msg.messageTimestamp
    ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString();

  const saved: ChatMessage = store.appendMessage({
    id: msg.key?.id || `msg-${Date.now()}`,
    groupId,
    from,
    authorName,
    text: text.trim(),
    fromMe: Boolean(msg.key?.fromMe),
    timestamp: ts,
    media: media.length ? media : undefined,
  });

  emit('message', saved);
  emit('groups', store.listGroups());
  logger.info(
    { group: groupName, author: authorName, preview: (text || `[${mediaMeta?.kind}]`).slice(0, 80) },
    'saved group message'
  );
}

async function syncGroups() {
  if (!sock) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [id, g] of Object.entries(groups || {}) as any) {
      store.upsertGroup({
        id,
        name: g.subject || id,
        memberCount: g.participants?.length,
        kind: 'group',
      });
    }
    emit('groups', store.listGroups());
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'group sync failed');
  }
}

export async function startBaileys() {
  stopped = false;
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: silent,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update: any) => {
    if (stopped) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      setStatus({
        connected: false,
        qr: await QRCode.toDataURL(qr),
        me: null,
        error: null,
        provider: 'baileys',
      });
      logger.info('QR ready — scan with the business WhatsApp');
    }
    if (connection === 'open') {
      reconnecting = false;
      const meId = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
      setStatus({
        connected: true,
        qr: null,
        me: { id: meId, name: sock.user?.name },
        error: null,
        provider: 'baileys',
      });
      logger.info({ me: meId }, 'WhatsApp (Baileys) connected');
      await syncGroups();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      setStatus({
        connected: false,
        qr: null,
        me: null,
        error: loggedOut
          ? 'Logged out — delete auth_info and restart to rescan QR'
          : `Disconnected (${code || 'unknown'})`,
        provider: 'baileys',
      });
      if (loggedOut || stopped) {
        if (loggedOut) logger.error('Logged out');
        return;
      }
      if (!reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          reconnecting = false;
          if (!stopped) startBaileys().catch((e) => logger.error(e));
        }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async (upsert: any) => {
    if (stopped) return;
    if (upsert.type !== 'notify' && upsert.type !== 'append') return;
    for (const msg of upsert.messages || []) {
      try {
        await handleIncoming(msg);
      } catch (e: any) {
        logger.error({ err: e?.message }, 'handle incoming');
      }
    }
  });

  sock.ev.on('groups.upsert', (groups: any[]) => {
    if (stopped) return;
    for (const g of groups || []) {
      store.upsertGroup({
        id: g.id,
        name: g.subject || g.id,
        memberCount: g.participants?.length,
        kind: 'group',
      });
    }
    emit('groups', store.listGroups());
  });
}

export async function stopBaileys() {
  stopped = true;
  reconnecting = false;
  const current = sock;
  sock = null;
  if (!current) return;
  try {
    current.ev.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    current.end(undefined);
  } catch {
    /* ignore */
  }
}
