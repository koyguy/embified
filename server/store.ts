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

function saveGroups(map: Record<string, GroupRecord>) {
  ensureDirs();
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(map, null, 2));
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

export function loadMessages(groupId: string): ChatMessage[] {
  try {
    return JSON.parse(fs.readFileSync(chatsFile(groupId), 'utf8'));
  } catch {
    return [];
  }
}

function saveMessages(groupId: string, messages: ChatMessage[]) {
  ensureDirs();
  fs.writeFileSync(chatsFile(groupId), JSON.stringify(messages, null, 2));
}

export function appendMessage(msg: ChatMessage): ChatMessage {
  const messages = loadMessages(msg.groupId);
  if (messages.some((m) => m.id === msg.id)) return msg;
  messages.push(msg);
  saveMessages(msg.groupId, messages);

  const preview =
    msg.text?.trim() ||
    (msg.media?.[0] ? `[${msg.media[0].kind}] ${msg.media[0].fileName}` : '');
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
