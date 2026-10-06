import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '../src/types.ts';
import * as store from './store.ts';

/**
 * WhatsApp history-sync reconciliation. Baileys emits `messaging-history.set` batches after a (re)link;
 * we merge group messages idempotently into the store and keep a JSON stamp (DATA_DIR/history-sync.json)
 * with counts so the operator can see what was recovered (GET /api/history/status).
 */

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STAMP_FILE = path.join(DATA_DIR, 'history-sync.json');

export const SYNC_TYPE_NAMES: Record<number, string> = {
  0: 'INITIAL_BOOTSTRAP',
  1: 'INITIAL_STATUS_V3',
  2: 'FULL',
  3: 'RECENT',
  4: 'PUSH_NAME',
  5: 'NON_BLOCKING_DATA',
  6: 'ON_DEMAND',
};

export interface GroupHistoryStats {
  name?: string;
  received: number;
  inserted: number;
  dupes: number;
  insertedSinceGap: number;
  earliest: string | null;
  latest: string | null;
}

export interface HistoryBatchLog {
  at: string;
  syncType: string;
  progress: number | null;
  isLatest: boolean | null;
  received: number;
  groupMessages: number;
  inserted: number;
  dupes: number;
  insertedSinceGap: number;
  earliest: string | null;
  latest: string | null;
}

export interface HistoryStamp {
  version: 1;
  /** Set when a QR is shown: the next history batch starts a new reconcile session. */
  awaitingLink: boolean;
  linkRequestedAt: string | null;
  /** Latest message the vault already had when this link's first history batch arrived. */
  gapStart: string | null;
  sessionStartedAt: string | null;
  firstSyncAt: string | null;
  lastSyncAt: string | null;
  batches: number;
  totals: {
    received: number;
    groupMessages: number;
    inserted: number;
    dupes: number;
    skippedNonGroup: number;
    skippedEmpty: number;
    insertedSinceGap: number;
  };
  earliest: string | null;
  latest: string | null;
  bySyncType: Record<string, number>;
  perGroup: Record<string, GroupHistoryStats>;
  recentBatches: HistoryBatchLog[];
  media: { queued: number; saved: number; failed: number; skippedOld: number };
  previousSessions: Array<Pick<HistoryStamp, 'gapStart' | 'sessionStartedAt' | 'lastSyncAt' | 'batches' | 'totals'>>;
}

function emptyTotals(): HistoryStamp['totals'] {
  return { received: 0, groupMessages: 0, inserted: 0, dupes: 0, skippedNonGroup: 0, skippedEmpty: 0, insertedSinceGap: 0 };
}

export function emptyStamp(): HistoryStamp {
  return {
    version: 1,
    awaitingLink: false,
    linkRequestedAt: null,
    gapStart: null,
    sessionStartedAt: null,
    firstSyncAt: null,
    lastSyncAt: null,
    batches: 0,
    totals: emptyTotals(),
    earliest: null,
    latest: null,
    bySyncType: {},
    perGroup: {},
    recentBatches: [],
    media: { queued: 0, saved: 0, failed: 0, skippedOld: 0 },
    previousSessions: [],
  };
}

export function readStamp(): HistoryStamp {
  try {
    return { ...emptyStamp(), ...JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8')) };
  } catch {
    return emptyStamp();
  }
}

export function writeStamp(stamp: HistoryStamp) {
  store.writeJsonAtomic(STAMP_FILE, stamp);
}

/** Called whenever a QR is displayed: the next history batch belongs to a fresh link. */
export function markAwaitingLink(now = new Date()) {
  const s = readStamp();
  if (s.awaitingLink) return;
  s.awaitingLink = true;
  s.linkRequestedAt = now.toISOString();
  writeStamp(s);
}

export function updateMediaStats(delta: Partial<HistoryStamp['media']>) {
  const s = readStamp();
  for (const [k, v] of Object.entries(delta)) {
    (s.media as any)[k] = ((s.media as any)[k] || 0) + (v || 0);
  }
  writeStamp(s);
}

function minIso(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}
function maxIso(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export interface HistoryBatchInput {
  syncType?: number | null;
  progress?: number | null;
  isLatest?: boolean | null;
  /** Total messages Baileys handed us in this batch (all chats). */
  received: number;
  skippedNonGroup: number;
  skippedEmpty: number;
  /** Group messages already converted to vault records. */
  messages: ChatMessage[];
  /** Group subjects from the history payload's chat list. */
  groupNames?: Record<string, string>;
}

export interface HistoryBatchResult {
  log: HistoryBatchLog;
  inserted: ChatMessage[];
  gapStart: string | null;
  sinceCount: number | null;
  touchedGroups: string[];
}

/** Count of inserted messages at/after `sinceIso` (e.g. HISTORY_RECONCILE_SINCE). */
function countSince(msgs: ChatMessage[], sinceIso?: string | null) {
  if (!sinceIso) return null;
  const t = Date.parse(sinceIso);
  if (!Number.isFinite(t)) return null;
  return msgs.filter((m) => Date.parse(m.timestamp) >= t).length;
}

export function mergeHistoryBatch(input: HistoryBatchInput, now = new Date(), sinceIso = process.env.HISTORY_RECONCILE_SINCE): HistoryBatchResult {
  let stamp = readStamp();
  const iso = now.toISOString();

  // New reconcile session for a fresh link (or first ever): snapshot the gap start before merging.
  if (stamp.awaitingLink || !stamp.sessionStartedAt) {
    const prev = stamp;
    stamp = emptyStamp();
    if (prev.sessionStartedAt) {
      stamp.previousSessions = [
        { gapStart: prev.gapStart, sessionStartedAt: prev.sessionStartedAt, lastSyncAt: prev.lastSyncAt, batches: prev.batches, totals: prev.totals },
        ...(prev.previousSessions || []),
      ].slice(0, 5);
    }
    stamp.linkRequestedAt = prev.linkRequestedAt;
    stamp.media = prev.media || stamp.media;
    // HISTORY_RECONCILE_SINCE pins the gap start (e.g. the logout time) when live messages already
    // trickled in before the relink; otherwise use the latest message the vault had.
    const pinned = sinceIso && Number.isFinite(Date.parse(sinceIso)) ? new Date(Date.parse(sinceIso)).toISOString() : null;
    stamp.gapStart = pinned || store.latestMessageTimestamp();
    stamp.sessionStartedAt = iso;
  }
  const gapStart = stamp.gapStart;
  const gapT = gapStart ? Date.parse(gapStart) : -Infinity;

  const byGroup = new Map<string, ChatMessage[]>();
  for (const m of input.messages) {
    if (!byGroup.has(m.groupId)) byGroup.set(m.groupId, []);
    byGroup.get(m.groupId)!.push(m);
  }

  const known = new Map(store.listGroups().map((g) => [g.id, g] as const));
  for (const [id, name] of Object.entries(input.groupNames || {})) {
    const prev = known.get(id);
    if (name && (!prev || prev.name === id)) store.upsertGroup({ id, name, kind: 'group' });
  }

  const allInserted: ChatMessage[] = [];
  let dupes = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const [groupId, msgs] of byGroup) {
    const res = store.mergeMessages(groupId, msgs, { unreadAfter: gapStart });
    dupes += res.dupes;
    allInserted.push(...res.inserted);
    let gE: string | null = null;
    let gL: string | null = null;
    for (const m of msgs) {
      gE = minIso(gE, m.timestamp);
      gL = maxIso(gL, m.timestamp);
    }
    earliest = minIso(earliest, gE);
    latest = maxIso(latest, gL);
    const pg = stamp.perGroup[groupId] || { received: 0, inserted: 0, dupes: 0, insertedSinceGap: 0, earliest: null, latest: null };
    pg.name = input.groupNames?.[groupId] || known.get(groupId)?.name || pg.name;
    pg.received += msgs.length;
    pg.inserted += res.inserted.length;
    pg.dupes += res.dupes;
    pg.insertedSinceGap += res.inserted.filter((m) => Date.parse(m.timestamp) > gapT).length;
    pg.earliest = minIso(pg.earliest, gE);
    pg.latest = maxIso(pg.latest, gL);
    stamp.perGroup[groupId] = pg;
  }

  const insertedSinceGap = allInserted.filter((m) => Date.parse(m.timestamp) > gapT).length;
  const syncType = input.syncType != null ? SYNC_TYPE_NAMES[input.syncType] || String(input.syncType) : 'UNKNOWN';
  const log: HistoryBatchLog = {
    at: iso,
    syncType,
    progress: input.progress ?? null,
    isLatest: input.isLatest ?? null,
    received: input.received,
    groupMessages: input.messages.length,
    inserted: allInserted.length,
    dupes,
    insertedSinceGap,
    earliest,
    latest,
  };

  stamp.awaitingLink = false;
  stamp.firstSyncAt = stamp.firstSyncAt || iso;
  stamp.lastSyncAt = iso;
  stamp.batches += 1;
  stamp.totals.received += input.received;
  stamp.totals.groupMessages += input.messages.length;
  stamp.totals.inserted += allInserted.length;
  stamp.totals.dupes += dupes;
  stamp.totals.skippedNonGroup += input.skippedNonGroup;
  stamp.totals.skippedEmpty += input.skippedEmpty;
  stamp.totals.insertedSinceGap += insertedSinceGap;
  stamp.earliest = minIso(stamp.earliest, earliest);
  stamp.latest = maxIso(stamp.latest, latest);
  stamp.bySyncType[syncType] = (stamp.bySyncType[syncType] || 0) + 1;
  stamp.recentBatches = [log, ...stamp.recentBatches].slice(0, 40);
  writeStamp(stamp);

  return {
    log,
    inserted: allInserted,
    gapStart,
    sinceCount: countSince(allInserted, sinceIso),
    touchedGroups: [...byGroup.keys()],
  };
}

/**
 * Live reconcile view straight from the store: per group, messages at/after `since`
 * and how many of those came from history sync.
 */
export function reconcileReport(sinceIso: string) {
  const t = Date.parse(sinceIso);
  if (!Number.isFinite(t)) throw new Error('invalid since');
  const groups = store.listGroups();
  const rows = [];
  let total = 0;
  let fromHistory = 0;
  for (const g of groups) {
    const msgs = store.loadMessages(g.id).filter((m) => Date.parse(m.timestamp) >= t);
    if (!msgs.length) continue;
    const hist = msgs.filter((m) => m.source === 'history').length;
    total += msgs.length;
    fromHistory += hist;
    rows.push({
      id: g.id,
      name: g.name,
      messagesSince: msgs.length,
      fromHistory: hist,
      earliest: msgs.reduce<string | null>((a, m) => minIso(a, m.timestamp), null),
      latest: msgs.reduce<string | null>((a, m) => maxIso(a, m.timestamp), null),
    });
  }
  rows.sort((a, b) => b.messagesSince - a.messagesSince);
  return { since: new Date(t).toISOString(), groupsWithMessages: rows.length, messagesSince: total, fromHistory, groups: rows };
}
