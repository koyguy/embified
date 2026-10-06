import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// store/history read DATA_DIR at import time, so point it at a temp dir before importing them.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embified-hist-'));
process.env.DATA_DIR = dir;

let store: typeof import('./store.ts');
let history: typeof import('./history.ts');
let baileys: typeof import('./baileys.ts');

const G = '120363000000000001@g.us';
const msg = (id: string, iso: string, extra: Record<string, unknown> = {}) => ({
  id,
  groupId: G,
  from: '9100000000',
  authorName: 'A',
  text: `m ${id}`,
  fromMe: false,
  timestamp: iso,
  ...extra,
});

before(async () => {
  store = await import('./store.ts');
  history = await import('./history.ts');
  baileys = await import('./baileys.ts');
});

describe('history merge', () => {
  it('dedupes against stored + in-batch messages, keeps timestamps, sorts chronologically', () => {
    store.upsertGroup({ id: G, name: 'Test group', kind: 'group' });
    // Live messages captured before the logout (appended in arrival order).
    store.appendMessage(msg('live-1', '2026-09-28T10:00:00.000Z'));
    store.appendMessage(msg('live-2', '2026-09-28T10:40:00.000Z'));
    const unreadBefore = store.listGroups()[0].unread;

    const res = history.mergeHistoryBatch(
      {
        syncType: 3,
        progress: 50,
        isLatest: true,
        received: 6,
        skippedNonGroup: 1,
        skippedEmpty: 0,
        messages: [
          msg('gap-2', '2026-10-01T09:00:00.000Z', { source: 'history' }),
          msg('live-2', '2026-09-28T10:40:00.000Z', { source: 'history' }), // dupe of stored
          msg('old-1', '2026-09-20T08:00:00.000Z', { source: 'history' }), // older than gap
          msg('gap-1', '2026-09-29T12:00:00.000Z', { source: 'history' }),
          msg('gap-1', '2026-09-29T12:00:00.000Z', { source: 'history' }), // in-batch dupe
        ],
        groupNames: { [G]: 'Test group' },
      },
      new Date('2026-10-06T14:30:00.000Z'),
      '2026-09-28T00:00:00.000Z'
    );

    assert.equal(res.log.inserted, 3);
    assert.equal(res.log.dupes, 2);
    // HISTORY_RECONCILE_SINCE (3rd arg) pins the gap start.
    assert.equal(res.gapStart, '2026-09-28T00:00:00.000Z');
    assert.equal(res.log.insertedSinceGap, 2);
    assert.equal(res.sinceCount, 2);
    assert.equal(res.log.earliest, '2026-09-20T08:00:00.000Z');
    assert.equal(res.log.latest, '2026-10-01T09:00:00.000Z');

    const stored = store.loadMessages(G);
    assert.deepEqual(
      stored.map((m) => m.id),
      ['old-1', 'live-1', 'live-2', 'gap-1', 'gap-2']
    );
    assert.equal(stored.find((m) => m.id === 'gap-1')!.timestamp, '2026-09-29T12:00:00.000Z');
    assert.equal(stored.find((m) => m.id === 'live-2')!.source, undefined, 'stored live copy is untouched');

    const g = store.listGroups().find((x) => x.id === G)!;
    assert.equal(g.messageCount, 5);
    assert.equal(g.lastAt, '2026-10-01T09:00:00.000Z');
    // Only gap messages (newer than gap start) bump unread; the old backfill doesn't.
    assert.equal(g.unread, unreadBefore + 2);

    const stamp = history.readStamp();
    assert.equal(stamp.batches, 1);
    assert.equal(stamp.totals.inserted, 3);
    assert.equal(stamp.totals.skippedNonGroup, 1);
    assert.equal(stamp.perGroup[G].insertedSinceGap, 2);
    assert.equal(stamp.bySyncType.RECENT, 1);
  });

  it('is idempotent: replaying the same batch inserts nothing', () => {
    const replay = history.mergeHistoryBatch({
      syncType: 2,
      received: 2,
      skippedNonGroup: 0,
      skippedEmpty: 0,
      messages: [msg('gap-1', '2026-09-29T12:00:00.000Z'), msg('gap-2', '2026-10-01T09:00:00.000Z')],
    });
    assert.equal(replay.log.inserted, 0);
    assert.equal(replay.log.dupes, 2);
    assert.equal(store.loadMessages(G).length, 5);
    // Same session keeps the original gap start.
    assert.equal(replay.gapStart, '2026-09-28T00:00:00.000Z');
  });

  it('starts a new session (fresh gap start = latest stored message) after a QR is shown', () => {
    history.markAwaitingLink();
    const res = history.mergeHistoryBatch({ syncType: 0, received: 0, skippedNonGroup: 0, skippedEmpty: 0, messages: [] }, new Date(), undefined);
    assert.equal(res.gapStart, '2026-10-01T09:00:00.000Z');
    const stamp = history.readStamp();
    assert.equal(stamp.previousSessions.length, 1);
    assert.equal(stamp.totals.inserted, 0);
  });

  it('HISTORY_RECONCILE_SINCE pins the gap start for a new session', () => {
    history.markAwaitingLink();
    const res = history.mergeHistoryBatch(
      { syncType: 3, received: 1, skippedNonGroup: 0, skippedEmpty: 0, messages: [msg('gap-1', '2026-09-29T12:00:00.000Z')] },
      new Date(),
      '2026-09-28T10:58:00Z'
    );
    assert.equal(res.gapStart, '2026-09-28T10:58:00.000Z');
    assert.equal(res.log.dupes, 1);
  });

  it('reconcile report counts messages since a date and how many came from history', () => {
    const r = history.reconcileReport('2026-09-28');
    assert.equal(r.messagesSince, 4);
    assert.equal(r.fromHistory, 2);
    assert.equal(r.groups[0].name, 'Test group');
  });

  it('converts Baileys history messages (incl. ephemeral wrappers) and skips DMs / empties', () => {
    const base = { key: { remoteJid: G, id: 'ABC', fromMe: false, participant: '919999999999@s.whatsapp.net' }, messageTimestamp: 1790000000, pushName: 'Bob' };
    const r = baileys.historyRecord({ ...base, message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'hello' } } } } });
    assert.equal(r.record?.text, 'hello');
    assert.equal(r.record?.source, 'history');
    assert.equal(r.record?.from, '919999999999');
    assert.equal(r.record?.timestamp, new Date(1790000000 * 1000).toISOString());
    // Long-style timestamps from protobuf decode.
    const long = baileys.historyRecord({ ...base, messageTimestamp: { low: 1790000000, high: 0, toNumber: () => 1790000000 }, message: { conversation: 'x' } });
    assert.equal(long.record?.timestamp, new Date(1790000000 * 1000).toISOString());
    const img = baileys.historyRecord({ ...base, message: { imageMessage: { mimetype: 'image/jpeg' } } });
    assert.equal(img.record?.mediaUnavailable?.kind, 'image');
    assert.equal(img.media?.kind, 'image');
    assert.equal(baileys.historyRecord({ ...base, key: { ...base.key, remoteJid: '919999999999@s.whatsapp.net' }, message: { conversation: 'dm' } }).reason, 'non_group');
    assert.equal(baileys.historyRecord({ ...base, message: { protocolMessage: { type: 0 } } }).reason, 'empty');
  });
});

describe('wa link state', () => {
  it('keeps `since` stable while the state is unchanged', async () => {
    const ws = await import('./wa-state.ts');
    const a = ws.recordWaState('logged_out', null, new Date('2026-09-28T10:58:00.000Z'));
    const b = ws.recordWaState('logged_out', null, new Date('2026-10-06T13:00:00.000Z'));
    assert.equal(b.since, a.since);
    assert.equal(b.lastLoggedOutAt, '2026-09-28T10:58:00.000Z');
    const c = ws.recordWaState('qr', null, new Date('2026-10-06T13:55:00.000Z'));
    assert.equal(c.since, '2026-10-06T13:55:00.000Z');
    assert.equal(c.lastLoggedOutAt, '2026-09-28T10:58:00.000Z');
  });
});
