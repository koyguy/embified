import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embified-store-'));
process.env.DATA_DIR = dir;

const store = await import('./store.ts');

const G = '120363000000009999@g.us';

function msg(id: string, text: string, ts: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    groupId: G,
    from: '91',
    authorName: extra.authorName as string || 'Ada',
    text,
    fromMe: false,
    timestamp: ts,
    ...extra,
  };
}

before(() => {
  store.upsertGroup({ id: G, name: 'Test chat', kind: 'group' });
  for (let i = 1; i <= 25; i++) {
    const ts = new Date(Date.UTC(2026, 0, i, 8, 0, 0)).toISOString();
    store.appendMessage(msg(`m${i}`, `hello ${i} apple`, ts, { authorName: i % 2 ? 'Ada' : 'Ben' }));
  }
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('queryMessages', () => {
  it('returns the latest page by default', () => {
    const page = store.queryMessages(G, { limit: 10 });
    assert.equal(page.total, 25);
    assert.equal(page.messages.length, 10);
    assert.equal(page.messages[0].id, 'm16');
    assert.equal(page.messages.at(-1)?.id, 'm25');
    assert.equal(page.hasMore, true);
    assert.equal(page.hasNewer, false);
  });

  it('pages older messages with before=', () => {
    const first = store.queryMessages(G, { limit: 10 });
    const older = store.queryMessages(G, { limit: 10, before: first.messages[0].id });
    assert.deepEqual(older.messages.map((m) => m.id), Array.from({ length: 10 }, (_, i) => `m${6 + i}`));
    assert.equal(older.hasMore, true);
    const oldest = store.queryMessages(G, { limit: 10, before: older.messages[0].id });
    assert.deepEqual(oldest.messages.map((m) => m.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
    assert.equal(oldest.hasMore, false);
  });

  it('returns only newer messages with after=', () => {
    const newer = store.queryMessages(G, { after: 'm23' });
    assert.deepEqual(newer.messages.map((m) => m.id), ['m24', 'm25']);
    assert.equal(newer.hasMore, true);
    assert.equal(newer.hasNewer, false);
  });

  it('searches text and author server-side', () => {
    const byAuthor = store.queryMessages(G, { q: 'ben', limit: 5 });
    assert.ok(byAuthor.total === 12); // m2,m4,...m24
    assert.equal(byAuthor.messages.length, 5);
    assert.ok(byAuthor.messages.every((m) => m.authorName === 'Ben'));
    const byText = store.queryMessages(G, { q: 'hello 1', limit: 20 });
    // 'hello 1', 'hello 10'..'hello 19'
    assert.equal(byText.total, 11);
    assert.ok(byText.messages.some((m) => m.id === 'm1'));
    assert.ok(byText.messages.some((m) => m.id === 'm11'));
  });
});
