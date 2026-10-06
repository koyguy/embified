import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { aggregate, allowRate, appendEvent, readStats, sanitizeEvent } from './funnel.ts';
import { isPublicPath } from './auth.ts';

describe('funnel sanitizeEvent', () => {
  it('accepts whitelisted events and strips extras', () => {
    const ev = sanitizeEvent({ event: 'level_done', cid: 'abc123XYZ', level: 3, ref: 'friend1', ip: '1.2.3.4', ua: 'x' });
    assert.ok(ev);
    assert.equal(ev!.e, 'level_done');
    assert.equal(ev!.lvl, 3);
    assert.equal(ev!.ref, 'friend1');
    assert.equal((ev as any).ip, undefined);
    assert.equal((ev as any).ua, undefined);
  });

  it('rejects unknown events and bad client ids', () => {
    assert.equal(sanitizeEvent({ event: 'hack', cid: 'abc123XYZ' }), null);
    assert.equal(sanitizeEvent({ event: 'view', cid: 'x' }), null);
    assert.equal(sanitizeEvent({ event: 'view', cid: '<script>alert(1)</script>' }), null);
    assert.equal(sanitizeEvent(null), null);
  });

  it('drops invalid level and ref', () => {
    const ev = sanitizeEvent({ event: 'view', cid: 'abc123XYZ', level: 99, ref: 'bad ref!' });
    assert.ok(ev);
    assert.equal(ev!.lvl, undefined);
    assert.equal(ev!.ref, undefined);
  });
});

describe('funnel aggregate + storage', () => {
  it('counts unique clients per level', () => {
    const lines = [
      JSON.stringify({ t: 'x', e: 'view', cid: 'aaaaaa' }),
      JSON.stringify({ t: 'x', e: 'view', cid: 'aaaaaa' }),
      JSON.stringify({ t: 'x', e: 'view', cid: 'bbbbbb', ref: 'r1' }),
      JSON.stringify({ t: 'x', e: 'level_done', cid: 'aaaaaa', lvl: 1 }),
      JSON.stringify({ t: 'x', e: 'level_done', cid: 'bbbbbb', lvl: 1 }),
      JSON.stringify({ t: 'x', e: 'level_done', cid: 'bbbbbb', lvl: 2 }),
      'not json',
    ];
    const s = aggregate(lines);
    assert.equal(s.uniqueClients, 2);
    assert.equal(s.events.view, 3);
    assert.equal(s.uniqueByEvent.view, 2);
    assert.deepEqual(s.levelsCompleted, { '1': 2, '2': 1 });
    assert.deepEqual(s.referrals, { r1: 1 });
  });

  it('appends JSONL and reads stats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-'));
    const file = path.join(dir, 'f.jsonl');
    appendEvent(sanitizeEvent({ event: 'start', cid: 'cccccc' })!, file);
    appendEvent(sanitizeEvent({ event: 'unlocked', cid: 'cccccc' })!, file);
    const s = readStats(file);
    assert.equal(s.uniqueClients, 1);
    assert.equal(s.events.unlocked, 1);
  });

  it('rate limits per key', () => {
    const now = 1_000;
    let ok = 0;
    for (let i = 0; i < 10; i++) if (allowRate('k-test', 5, 60_000, now)) ok++;
    assert.equal(ok, 5);
    assert.equal(allowRate('k-test', 5, 60_000, now + 61_000), true);
  });
});

describe('public paths', () => {
  it('keeps funnel endpoints behind the auth wall', () => {
    assert.equal(isPublicPath('/api/funnel/event'), false);
    assert.equal(isPublicPath('/api/funnel/stats'), false);
  });
});
