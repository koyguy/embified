import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ChatMessage } from '../src/types.ts';

/**
 * WhatsApp now addresses many users by a Linked ID (@lid) instead of a phone number
 * (@s.whatsapp.net). Mentions and some sender fields therefore show up as raw digit
 * strings like "@104380590231704". This module builds a persistent lid → phone/name
 * map and rewrites senders and @mentions at render time (already-stored messages are
 * not rewritten on disk).
 */

export type LidRecord = {
  lid?: string;
  phone?: string;
  name?: string;
  updatedAt: string;
};

type LidMap = {
  version: 1;
  records: Record<string, LidRecord>;
  phoneToLid: Record<string, string>;
};

let cache: { file: string; mtimeMs: number; size: number; data: LidMap } | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function mapFile() {
  return path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'lid-map.json');
}

function emptyMap(): LidMap {
  return { version: 1, records: {}, phoneToLid: {} };
}

/** Bare digits from a JID, @mention, or stored `from` field. */
export function bareId(input?: string | null): string {
  if (!input) return '';
  let s = String(input).trim();
  s = s.replace(/:\d+@/, '@');
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(0, at);
  if (s.startsWith('+')) s = s.slice(1);
  const digits = s.replace(/\D/g, '');
  return digits || '';
}

export function isLidId(input?: string | null): boolean {
  if (!input) return false;
  if (/@lid$/i.test(String(input))) return true;
  return /^\d{14,}$/.test(bareId(input));
}

export function isPhoneId(input?: string | null): boolean {
  if (!input) return false;
  if (/@(s\.whatsapp\.net|c\.us)$/i.test(String(input))) return true;
  const b = bareId(input);
  return /^\d{8,13}$/.test(b);
}

export function isHumanName(name?: string | null, ident?: string | null): boolean {
  const n = (name || '').trim();
  if (!n) return false;
  if (/@lid$/i.test(n) || /^\d{14,}$/.test(n)) return false;
  if (ident && bareId(n) && bareId(n) === bareId(ident) && /^\d+$/.test(bareId(n))) return false;
  return true;
}

export function formatPhone(phone?: string | null): string {
  const b = bareId(phone);
  return b ? `+${b}` : '';
}

export function loadMap(force = false): LidMap {
  const file = mapFile();
  try {
    const st = fs.statSync(file);
    if (!force && cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.data;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data: LidMap = {
      version: 1,
      records: raw?.records && typeof raw.records === 'object' ? raw.records : {},
      phoneToLid: raw?.phoneToLid && typeof raw.phoneToLid === 'object' ? raw.phoneToLid : {},
    };
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  } catch {
    // Don't wipe in-memory learns just because the file isn't on disk yet.
    if (cache && cache.file === file) return cache.data;
    const data = emptyMap();
    cache = { file, mtimeMs: 0, size: 0, data };
    return data;
  }
}

export function saveMap() {
  const data = cache?.data || loadMap();
  const file = mapFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const body = JSON.stringify({ version: 1, records: data.records, phoneToLid: data.phoneToLid }, null, 2);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    const st = fs.statSync(file);
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, data };
  } catch {
    /* ignore */
  }
  dirty = false;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) saveMap();
  }, 250);
}

function phoneKey(phone: string) {
  return `p:${phone}`;
}

function mergeRecord(into: LidRecord, src: Partial<LidRecord>): LidRecord {
  const next: LidRecord = { ...into, updatedAt: new Date().toISOString() };
  if (src.lid && isLidId(src.lid)) next.lid = bareId(src.lid);
  if (src.phone && !isLidId(src.phone) && bareId(src.phone)) next.phone = bareId(src.phone);
  if (src.name && isHumanName(src.name, next.lid || next.phone)) next.name = src.name.trim();
  return next;
}

/** Record a lid ↔ phone and/or lid/phone ↔ name association. */
export function learn(opts: { lid?: string | null; phone?: string | null; name?: string | null }): LidRecord | null {
  const lid = opts.lid && isLidId(opts.lid) ? bareId(opts.lid) : '';
  const phone = opts.phone && !isLidId(opts.phone) && (isPhoneId(opts.phone) || /^\d{8,13}$/.test(bareId(opts.phone)))
    ? bareId(opts.phone)
    : '';
  const name = isHumanName(opts.name, lid || phone) ? String(opts.name).trim() : '';
  if (!lid && !phone && !name) return null;

  const data = loadMap();
  let key = '';
  if (lid) key = lid;
  else if (phone && data.phoneToLid[phone]) key = data.phoneToLid[phone];
  else if (phone) key = phoneKey(phone);
  else return null;

  const prev = data.records[key] || (lid ? { lid, updatedAt: new Date().toISOString() } : { phone, updatedAt: new Date().toISOString() });
  const rec = mergeRecord(prev, { lid: lid || prev.lid, phone: phone || prev.phone, name: name || prev.name });
  data.records[key] = rec;
  if (rec.lid && rec.phone) {
    data.phoneToLid[rec.phone] = rec.lid;
    if (key !== rec.lid) {
      data.records[rec.lid] = rec;
      delete data.records[key];
    }
    delete data.records[phoneKey(rec.phone)];
  }
  cache = cache ? { ...cache, data } : { file: mapFile(), mtimeMs: 0, size: 0, data };
  scheduleSave();
  return rec;
}

export function lookup(id?: string | null): LidRecord | null {
  const b = bareId(id);
  if (!b) return null;
  const data = loadMap();
  if (data.records[b]) return data.records[b];
  const lid = data.phoneToLid[b];
  if (lid && data.records[lid]) return data.records[lid];
  if (data.records[phoneKey(b)]) return data.records[phoneKey(b)];
  return null;
}

export function displayName(
  id?: string | null,
  fallbackName?: string | null
): { display: string; resolved: boolean } {
  if (isHumanName(fallbackName, id)) {
    return { display: String(fallbackName).trim(), resolved: true };
  }
  const rec = lookup(id);
  if (rec?.name && isHumanName(rec.name, rec.lid || rec.phone || id)) {
    return { display: rec.name, resolved: true };
  }
  if (rec?.phone) return { display: formatPhone(rec.phone), resolved: true };
  if (id && isPhoneId(id) && !isLidId(id)) return { display: formatPhone(id), resolved: true };
  const fallback = (fallbackName || '').trim() || bareId(id) || '';
  return { display: fallback, resolved: false };
}

export const MENTION_RE = /@(\d{10,})/g;

export function rewriteMentions(text?: string | null): string {
  if (!text) return text || '';
  return text.replace(MENTION_RE, (full, digits: string) => {
    const rec = lookup(digits);
    if (rec?.name && isHumanName(rec.name, rec.lid || rec.phone || digits)) return `@${rec.name}`;
    if (rec?.phone) return `@${formatPhone(rec.phone)}`;
    if (isPhoneId(digits) && !isLidId(digits)) return `@${formatPhone(digits)}`;
    return full;
  });
}

export function resolveMessage(m: ChatMessage): ChatMessage {
  const { display } = displayName(m.from, m.authorName);
  const text = rewriteMentions(m.text || '');
  if (display === (m.authorName || '') && text === (m.text || '')) return m;
  return { ...m, authorName: display, text };
}

export function learnFromContact(c: any) {
  if (!c) return;
  const id = c.id || c.jid || c.lid;
  learn({
    lid: c.lid || (isLidId(id) ? id : null),
    phone: c.jid || c.phoneNumber || (isPhoneId(id) && !isLidId(id) ? id : null),
    name: c.name || c.notify || c.verifiedName || c.pushName,
  });
}

export function learnFromRawMessage(msg: any) {
  if (!msg) return;
  const key = msg.key || {};
  const participant = key.participant || msg.participant || key.remoteJid;
  learn({
    lid: key.participantLid || key.senderLid || (isLidId(participant) ? participant : null),
    phone: key.participantPn || key.senderPn || (isPhoneId(participant) && !isLidId(participant) ? participant : null),
    name: msg.pushName || msg.verifiedBizName,
  });
  const mentioned = collectMentionedJids(msg);
  for (const jid of mentioned) {
    if (isLidId(jid)) learn({ lid: jid });
    else if (isPhoneId(jid)) learn({ phone: jid });
  }
}

function collectMentionedJids(msg: any): string[] {
  const bag = new Set<string>();
  const visit = (m: any) => {
    if (!m || typeof m !== 'object') return;
    const ctx = m.contextInfo;
    if (ctx?.mentionedJid) for (const j of ctx.mentionedJid) if (j) bag.add(String(j));
    for (const v of Object.values(m)) {
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(msg.message || msg);
  return [...bag];
}

export function learnFromPhoneShare(ev: { lid?: string; jid?: string } | null) {
  if (!ev) return;
  learn({ lid: ev.lid, phone: ev.jid });
}

export function learnFromStoredMessages(messages: ChatMessage[]) {
  for (const m of messages) {
    if (!m) continue;
    if (isLidId(m.from) && isHumanName(m.authorName, m.from)) learn({ lid: m.from, name: m.authorName });
    else if (isPhoneId(m.from) && !isLidId(m.from) && isHumanName(m.authorName, m.from)) {
      learn({ phone: m.from, name: m.authorName });
    }
  }
}

/** Best-effort import from newer Baileys `signalRepository.lidMapping` when present. */
export async function importFromBaileysLidMapping(sock: any): Promise<number> {
  const lm = sock?.signalRepository?.lidMapping;
  if (!lm) return 0;
  let added = 0;
  try {
    const pairs: Array<{ lid?: string; pn?: string; phone?: string }> =
      (typeof lm.getAll === 'function' ? await lm.getAll() : null) ||
      (typeof lm.entries === 'function' ? await lm.entries() : null) ||
      [];
    if (Array.isArray(pairs)) {
      for (const p of pairs) {
        const rec = learn({ lid: p.lid, phone: p.pn || p.phone });
        if (rec?.lid && rec?.phone) added++;
      }
    }
  } catch {
    /* optional API */
  }
  return added;
}

export function mapStats() {
  const data = loadMap();
  const recs = Object.values(data.records);
  return {
    records: recs.length,
    withName: recs.filter((r) => r.name).length,
    withPhone: recs.filter((r) => r.phone).length,
    withLid: recs.filter((r) => r.lid).length,
  };
}

/** Tests / process shutdown: flush and drop the in-memory cache. */
export function resetLidMapCache() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) saveMap();
  cache = null;
  dirty = false;
}
