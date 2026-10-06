import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  normalizeMessageContent,
  toNumber,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import * as store from './store.ts';
import { emit, setStatus } from './bus.ts';
import { markAwaitingLink, mergeHistoryBatch, readStamp, updateMediaStats } from './history.ts';
import { readWaState, recordWaState } from './wa-state.ts';
import type { ChatMessage, MediaKind, WaLinkState } from '../src/types.ts';

const AUTH_DIR = path.resolve(process.env.AUTH_DIR || path.join(process.cwd(), 'auth_info'));
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const silent = pino({ level: 'silent' });
/** History media newer than this many days is downloaded in the background (0 disables). */
const HISTORY_MEDIA_DAYS = Number(process.env.HISTORY_MEDIA_DAYS ?? 45);
const HISTORY_MEDIA_QUEUE_MAX = Number(process.env.HISTORY_MEDIA_QUEUE_MAX ?? 5000);

let sock: any = null;
let reconnecting = false;
let stopped = true;

function setLinkState(state: WaLinkState, detail?: string | null) {
  const rec = recordWaState(state, detail);
  setStatus({ waState: rec.state, waStateSince: rec.since });
}

function content(msg: any) {
  try {
    return normalizeMessageContent(msg?.message) || msg?.message;
  } catch {
    return msg?.message;
  }
}

function extractText(msg: any): string {
  const m = content(msg);
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
  const m = content(msg);
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

function msgTimestampIso(msg: any) {
  const n = Number(toNumber(msg?.messageTimestamp));
  return n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

function authorOf(msg: any) {
  const fromJid = msg.key?.participant || msg.participant || msg.key?.remoteJid;
  const from = fromJid ? jidNormalizedUser(fromJid).split('@')[0] : 'unknown';
  return { from, authorName: msg.pushName || msg.verifiedBizName || from };
}

async function downloadMedia(msg: any, meta: { kind: MediaKind; mimetype: string; fileName: string }) {
  const buf = await downloadMediaMessage(msg, 'buffer', {}, {
    logger: silent,
    reuploadRequest: sock?.updateMediaMessage,
  } as any);
  if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
    return store.saveMedia(buf, meta.mimetype, meta.fileName, meta.kind);
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
      const saved = await downloadMedia(msg, mediaMeta);
      if (saved) media.push(saved);
    } catch (e: any) {
      logger.warn({ err: e?.message }, 'media download failed');
    }
  }

  const { from, authorName } = authorOf(msg);
  const saved: ChatMessage = store.appendMessage({
    id: msg.key?.id || `msg-${Date.now()}`,
    groupId,
    from,
    authorName,
    text: text.trim(),
    fromMe: Boolean(msg.key?.fromMe),
    timestamp: msgTimestampIso(msg),
    media: media.length ? media : undefined,
    mediaUnavailable: mediaMeta && !media.length ? { kind: mediaMeta.kind, fileName: mediaMeta.fileName } : undefined,
  });

  emit('message', saved);
  emit('groups', store.listGroups());
  logger.info(
    { group: groupName, author: authorName, preview: (text || `[${mediaMeta?.kind}]`).slice(0, 80) },
    'saved group message'
  );
}

/* ---------------- history sync ---------------- */

const mediaQueue: Array<{ groupId: string; id: string; raw: any; meta: { kind: MediaKind; mimetype: string; fileName: string } }> = [];
let mediaWorkers = 0;

function pumpMediaQueue() {
  while (mediaWorkers < 2 && mediaQueue.length && sock && !stopped) {
    const job = mediaQueue.shift()!;
    mediaWorkers++;
    (async () => {
      try {
        const saved = await downloadMedia(job.raw, job.meta);
        if (saved) {
          store.attachMedia(job.groupId, job.id, [saved]);
          updateMediaStats({ saved: 1 });
        } else {
          updateMediaStats({ failed: 1 });
        }
      } catch {
        updateMediaStats({ failed: 1 });
      } finally {
        mediaWorkers--;
        if (!mediaQueue.length && mediaWorkers === 0) {
          logger.info({ media: readStamp().media }, 'history media queue drained');
          emit('history', { groups: [] });
        }
        setTimeout(pumpMediaQueue, 250);
      }
    })();
  }
}

/** Exported for tests: converts a Baileys WAMessage from history into a vault record (no network). */
export function historyRecord(msg: any): { record: ChatMessage | null; reason?: 'non_group' | 'empty'; media?: ReturnType<typeof detectMedia> } {
  const remoteJid = msg?.key?.remoteJid;
  if (!remoteJid || isJidStatusBroadcast(remoteJid) || !isJidGroup(remoteJid)) return { record: null, reason: 'non_group' };
  if (!msg.message || !msg.key?.id) return { record: null, reason: 'empty' };
  const text = extractText(msg).trim();
  const media = detectMedia(msg);
  if (!text && !media) return { record: null, reason: 'empty' };
  const { from, authorName } = authorOf(msg);
  return {
    record: {
      id: msg.key.id,
      groupId: remoteJid,
      from,
      authorName,
      text,
      fromMe: Boolean(msg.key.fromMe),
      timestamp: msgTimestampIso(msg),
      source: 'history',
      mediaUnavailable: media ? { kind: media.kind, fileName: media.fileName } : undefined,
    },
    media,
  };
}

function handleHistorySet(payload: any) {
  const { chats = [], messages = [], syncType, progress, isLatest } = payload || {};
  const groupNames: Record<string, string> = {};
  for (const c of chats) {
    if (c?.id && isJidGroup(c.id) && (c.name || c.subject)) groupNames[c.id] = c.name || c.subject;
  }
  const records: ChatMessage[] = [];
  const rawById = new Map<string, { raw: any; meta: NonNullable<ReturnType<typeof detectMedia>> }>();
  let skippedNonGroup = 0;
  let skippedEmpty = 0;
  for (const m of messages) {
    const r = historyRecord(m);
    if (!r.record) {
      if (r.reason === 'non_group') skippedNonGroup++;
      else skippedEmpty++;
      continue;
    }
    records.push(r.record);
    if (r.media) rawById.set(`${r.record.groupId}|${r.record.id}`, { raw: m, meta: r.media });
  }

  const res = mergeHistoryBatch({
    syncType,
    progress,
    isLatest,
    received: messages.length,
    skippedNonGroup,
    skippedEmpty,
    messages: records,
    groupNames,
  });

  logger.info(
    {
      syncType: res.log.syncType,
      progress: res.log.progress,
      isLatest: res.log.isLatest,
      chats: chats.length,
      received: res.log.received,
      groupMessages: res.log.groupMessages,
      inserted: res.log.inserted,
      dupes: res.log.dupes,
      skippedNonGroup,
      skippedEmpty,
      earliest: res.log.earliest,
      latest: res.log.latest,
      gapStart: res.gapStart,
      insertedSinceGap: res.log.insertedSinceGap,
      ...(res.sinceCount != null ? { since: process.env.HISTORY_RECONCILE_SINCE, insertedSince: res.sinceCount } : {}),
    },
    'history sync batch merged'
  );

  // Best-effort background media for recovered messages (never blocks the merge).
  const cutoff = HISTORY_MEDIA_DAYS > 0 ? Date.now() - HISTORY_MEDIA_DAYS * 86400_000 : Infinity;
  let queued = 0;
  let skippedOld = 0;
  for (const rec of res.inserted) {
    const job = rawById.get(`${rec.groupId}|${rec.id}`);
    if (!job) continue;
    if (Date.parse(rec.timestamp) < cutoff || mediaQueue.length >= HISTORY_MEDIA_QUEUE_MAX) {
      skippedOld++;
      continue;
    }
    mediaQueue.push({ groupId: rec.groupId, id: rec.id, raw: job.raw, meta: job.meta });
    queued++;
  }
  if (queued || skippedOld) updateMediaStats({ queued, skippedOld });
  pumpMediaQueue();

  if (res.inserted.length) {
    emit('groups', store.listGroups());
    emit('history', { groups: res.touchedGroups, inserted: res.inserted.length });
  }
}

/* ---------------- socket ---------------- */

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
  const prev = readWaState();
  if (prev) setStatus({ waState: prev.state, waStateSince: prev.since });

  sock = makeWASocket({
    version,
    auth: state,
    logger: silent,
    printQRInTerminal: false,
    // Ask the phone for history at link time (requireFullSync). Only takes effect on a NEW link (QR scan).
    // NOTE: Browsers.macOS('Desktop') / windows('Desktop') would request the larger "desktop" history,
    // but since ~2026-06-30 WhatsApp rejects the DARWIN/WIN32 web sub-platform that Baileys 6.7.x sends
    // with syncFullHistory (428 before QR — Baileys #2671/#2677). In 6.7.x any 'Mac OS'/'Windows' tuple
    // + syncFullHistory hits that, so we stay on the Ubuntu/Chrome web identity, which pairs fine and
    // still receives INITIAL_BOOTSTRAP + RECENT history. Revisit after upgrading to a Baileys release
    // with WIN_HYBRID / MACOS support (#2693, #2741).
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);
  let qrLogged = false;

  sock.ev.on('connection.update', async (update: any) => {
    if (stopped) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      markAwaitingLink();
      setStatus({
        connected: false,
        qr: await QRCode.toDataURL(qr),
        me: null,
        error: null,
        provider: 'baileys',
      });
      if (!qrLogged) logger.info('QR ready — scan with the business WhatsApp');
      qrLogged = true;
      setLinkState('qr');
    }
    if (connection === 'open') {
      reconnecting = false;
      const meId = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
      setLinkState('connected');
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
      setLinkState(loggedOut ? 'logged_out' : 'disconnected', loggedOut ? 'loggedOut (401)' : `close ${code || 'unknown'}`);
      setStatus({
        connected: false,
        qr: null,
        me: null,
        error: loggedOut
          ? 'Logged out — this vault is no longer linked. Use “Reset & show QR” to relink.'
          : `Disconnected (${code || 'unknown'})`,
        provider: 'baileys',
      });
      if (loggedOut || stopped) {
        if (loggedOut) logger.error({ waState: 'logged_out', since: readWaState()?.since }, 'Logged out');
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

  sock.ev.on('messaging-history.set', (payload: any) => {
    if (stopped) return;
    try {
      handleHistorySet(payload);
    } catch (e: any) {
      logger.error({ err: e?.message }, 'history sync merge failed');
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

export function isBaileysConnected() {
  return Boolean(sock?.user) && readWaState()?.state === 'connected';
}

/**
 * Move (never delete) the auth folder aside so the next start shows a fresh QR.
 * The caller restarts the socket. Returns the backup path (or null if there was nothing to move).
 */
export async function moveAuthAside(): Promise<string | null> {
  await stopBaileys();
  if (!fs.existsSync(AUTH_DIR) || fs.readdirSync(AUTH_DIR).length === 0) return null;
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const dest = `${AUTH_DIR}.reset-${ts}`;
  fs.renameSync(AUTH_DIR, dest);
  logger.warn({ from: AUTH_DIR, to: dest }, 'auth_info moved aside for relink');
  return dest;
}

/**
 * Ask the phone for older messages in groups (ON_DEMAND history). Anchors on the earliest stored
 * message at/after `since`; replies (if WhatsApp sends any) arrive via messaging-history.set and are
 * merged like any other batch. Best-effort: WhatsApp often ignores these for companion devices.
 */
export async function requestBackfill(opts: { since: string; count?: number; groupId?: string }) {
  if (!sock?.user) throw new Error('not connected');
  const t = Date.parse(opts.since);
  if (!Number.isFinite(t)) throw new Error('invalid since');
  const count = Math.max(1, Math.min(Number(opts.count) || 50, 200));
  const ids = opts.groupId ? [opts.groupId] : store.listGroupIdsWithChats();
  const results: Array<{ groupId: string; anchor?: string; anchorAt?: string; requested: boolean; sessionId?: string; error?: string; reason?: string }> = [];
  for (const groupId of ids) {
    const anchor = store
      .loadMessages(groupId)
      .filter((m) => Date.parse(m.timestamp) >= t)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0];
    if (!anchor) {
      results.push({ groupId, requested: false, reason: 'no stored message after since to anchor on yet' });
      continue;
    }
    try {
      const sessionId = await sock.fetchMessageHistory(
        count,
        { remoteJid: groupId, id: anchor.id, fromMe: anchor.fromMe },
        Math.floor(Date.parse(anchor.timestamp) / 1000)
      );
      results.push({ groupId, anchor: anchor.id, anchorAt: anchor.timestamp, requested: true, sessionId });
    } catch (e: any) {
      results.push({ groupId, anchor: anchor.id, requested: false, error: e?.message || 'failed' });
    }
  }
  logger.info({ since: opts.since, requested: results.filter((r) => r.requested).length, groups: results.length }, 'history backfill requested');
  return results;
}
