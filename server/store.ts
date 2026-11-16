import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ChatMessage, GroupSummary, MediaAttachment, MediaKind } from '../src/types.ts';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const MAX_MEDIA = Number(process.env.MEDIA_MAX_BYTES || 15 * 1024 * 1024);

interface GroupRecord extends GroupSummary {
  participants?: string[];
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function chatsFile(groupId: string) {
  const safe = groupId.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(DATA_DIR, `chat-${safe}.json`);
}

function loadGroups(): Record<string, GroupRecord> {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Write via temp file + rename so a crash mid-write never truncates a chat file. */
export function writeJsonAtomic(file: string, data: unknown) {
  ensureDirs();
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function saveGroups(map: Record<string, GroupRecord>) {
  writeJsonAtomic(GROUPS_FILE, map);
}

export function listGroups(): GroupSummary[] {
  const map = loadGroups();
  return Object.values(map).sort((a, b) => {
    const ta = a.lastAt ? Date.parse(a.lastAt) : 0;
    const tb = b.lastAt ? Date.parse(b.lastAt) : 0;
    return tb - ta;
  });
}

export function upsertGroup(partial: Partial<GroupRecord> & { id: string; name: string }) {
  const map = loadGroups();
  const prev = map[partial.id] || {
    id: partial.id,
    name: partial.name,
    unread: 0,
    messageCount: 0,
  };
  map[partial.id] = { ...prev, ...partial, name: partial.name || prev.name };
  saveGroups(map);
  return map[partial.id];
}

const messageCache = new Map<string, { mtimeMs: number; size: number; messages: ChatMessage[] }>();

export function loadMessages(groupId: string): ChatMessage[] {
  const file = chatsFile(groupId);
  try {
    const st = fs.statSync(file);
    const hit = messageCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.messages;
    const messages: ChatMessage[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    messageCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, messages });
    return messages;
  } catch {
    messageCache.delete(file);
    return [];
  }
}

export const DEFAULT_PAGE_SIZE = 200;
export const MAX_PAGE_SIZE = 500;

export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  hasNewer: boolean;
  total: number;
}

function clampPageSize(n?: number) {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(n)));
}

/**
 * Paginated / searched view of a chat. Messages are stored oldest → newest.
 *  - default: the latest `limit` messages (hasMore if older ones exist)
 *  - before=<id>: older page ending just before that message
 *  - after=<id>: newer messages after that message (live catch-up)
 *  - q: case-insensitive match on text, author, or attachment file name
 */
export function queryMessages(
  groupId: string,
  opts: { limit?: number; before?: string; after?: string; q?: string } = {}
): MessagePage {
  let all = loadMessages(groupId);
  const q = opts.q?.trim().toLowerCase() || '';
  if (q) {
    all = all.filter((m) => {
      if ((m.text || '').toLowerCase().includes(q)) return true;
      if ((m.authorName || '').toLowerCase().includes(q)) return true;
      if (m.media?.some((a) => (a.fileName || '').toLowerCase().includes(q))) return true;
      if ((m.mediaUnavailable?.fileName || '').toLowerCase().includes(q)) return true;
      return false;
    });
  }
  const limit = clampPageSize(opts.limit);

  if (opts.after) {
    let start = all.findIndex((m) => m.id === opts.after);
    start = start >= 0 ? start + 1 : all.findIndex((m) => tsOf(m.timestamp) > tsOf(opts.after));
    if (start < 0) start = all.length;
    const messages = all.slice(start, start + limit);
    return { messages, hasMore: start > 0, hasNewer: start + messages.length < all.length, total: all.length };
  }

  let end = all.length;
  if (opts.before) {
    const i = all.findIndex((m) => m.id === opts.before);
    if (i >= 0) end = i;
  }
  const start = Math.max(0, end - limit);
  return { messages: all.slice(start, end), hasMore: start > 0, hasNewer: end < all.length, total: all.length };
}

function saveMessages(groupId: string, messages: ChatMessage[]) {
  const file = chatsFile(groupId);
  writeJsonAtomic(file, messages);
  messageCache.delete(file);
}

function previewOf(msg: ChatMessage) {
  return (
    msg.text?.trim() ||
    (msg.media?.[0] ? `[${msg.media[0].kind}] ${msg.media[0].fileName}` : '') ||
    (msg.mediaUnavailable ? `[${msg.mediaUnavailable.kind}]` : '')
  ).slice(0, 140);
}

function tsOf(iso?: string) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export interface MergeResult {
  inserted: ChatMessage[];
  dupes: number;
}

/**
 * Bulk, idempotent merge (used by WhatsApp history sync). Dedupes by message key id against what is
 * already stored and within the batch, keeps original timestamps, re-sorts the chat chronologically
 * (stable) and writes the chat + group summary once per call.
 * Unread only counts inserted messages newer than `unreadAfter` (defaults to the group's previous lastAt),
 * so a large backfill of old history doesn't explode the badge.
 */
export function mergeMessages(
  groupId: string,
  incoming: ChatMessage[],
  opts: { unreadAfter?: string | null } = {}
): MergeResult {
  const existing = loadMessages(groupId);
  const seen = new Set(existing.map((m) => m.id));
  const inserted: ChatMessage[] = [];
  let dupes = 0;
  for (const m of incoming) {
    if (!m?.id || seen.has(m.id)) {
      dupes++;
      continue;
    }
    seen.add(m.id);
    inserted.push({ ...m, groupId });
  }
  if (!inserted.length) return { inserted, dupes };

  const all = existing
    .concat(inserted)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => tsOf(a.m.timestamp) - tsOf(b.m.timestamp) || a.i - b.i)
    .map((x) => x.m);
  saveMessages(groupId, all);

  const map = loadGroups();
  const g = map[groupId] || { id: groupId, name: groupId, unread: 0, messageCount: 0 };
  const prevLast = g.lastAt;
  const last = all[all.length - 1];
  g.messageCount = all.length;
  if (!prevLast || tsOf(last.timestamp) >= tsOf(prevLast)) {
    g.lastAt = last.timestamp;
    g.lastMessage = previewOf(last);
  }
  const cutoff = opts.unreadAfter !== undefined ? opts.unreadAfter : prevLast;
  if (cutoff) {
    const c = tsOf(cutoff);
    g.unread = (g.unread || 0) + inserted.filter((m) => !m.fromMe && tsOf(m.timestamp) > c).length;
  }
  map[groupId] = g;
  saveGroups(map);
  return { inserted, dupes };
}

/** Attach media downloaded after the message was stored (history media is fetched in the background). */
export function attachMedia(groupId: string, id: string, media: MediaAttachment[]): ChatMessage | null {
  const messages = loadMessages(groupId);
  const msg = messages.find((m) => m.id === id);
  if (!msg) return null;
  msg.media = media;
  delete msg.mediaUnavailable;
  saveMessages(groupId, messages);
  return msg;
}

/** Latest stored message timestamp across all groups (used as the "gap start" when a relink syncs history). */
export function latestMessageTimestamp(): string | null {
  let best: string | null = null;
  for (const g of Object.values(loadGroups())) {
    if (g.lastAt && (!best || tsOf(g.lastAt) > tsOf(best))) best = g.lastAt;
  }
  return best;
}

export function listGroupIdsWithChats(): string[] {
  return Object.keys(loadGroups());
}

export function appendMessage(msg: ChatMessage): ChatMessage {
  const messages = loadMessages(msg.groupId);
  if (messages.some((m) => m.id === msg.id)) return msg;
  messages.push(msg);
  saveMessages(msg.groupId, messages);

  const preview = previewOf(msg);
  const map = loadGroups();
  const g = map[msg.groupId] || {
    id: msg.groupId,
    name: msg.groupId,
    unread: 0,
    messageCount: 0,
  };
  g.lastMessage = preview.slice(0, 140);
  g.lastAt = msg.timestamp;
  g.messageCount = messages.length;
  if (!msg.fromMe) g.unread = (g.unread || 0) + 1;
  map[msg.groupId] = g;
  saveGroups(map);
  return msg;
}

export function markRead(groupId: string) {
  const map = loadGroups();
  if (map[groupId]) {
    map[groupId].unread = 0;
    saveGroups(map);
  }
}

function extFromMime(mimetype: string, fileName?: string) {
  if (fileName && path.extname(fileName)) return path.extname(fileName);
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
  };
  return map[mimetype] || '.bin';
}

export function kindFromMime(mimetype: string, hint?: string): MediaKind {
  if (hint === 'sticker') return 'sticker';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.includes('pdf') || mimetype.includes('document') || mimetype.includes('msword')) {
    return 'document';
  }
  return 'other';
}

export function saveMedia(buf: Buffer, mimetype: string, fileName?: string, kind?: MediaKind): MediaAttachment {
  ensureDirs();
  if (buf.length > MAX_MEDIA) {
    throw new Error(`Media too large (${buf.length})`);
  }
  const id = `med-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const ext = extFromMime(mimetype, fileName);
  const safe = (fileName || `file${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const disk = `${id}-${safe}`;
  fs.writeFileSync(path.join(MEDIA_DIR, disk), buf);
  return {
    id,
    kind: kind || kindFromMime(mimetype),
    mimetype,
    fileName: fileName || safe,
    size: buf.length,
    url: `/media/${disk}`,
  };
}

export function getMediaDir() {
  ensureDirs();
  return MEDIA_DIR;
}

export { DATA_DIR };
