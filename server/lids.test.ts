import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embified-lids-'));
process.env.DATA_DIR = dir;

const lids = await import('./lids.ts');

const LID = '104380590231704';
const SENDER_LID = '243314511102000';

after(() => {
  lids.resetLidMapCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lid helpers', () => {
  it('recognises lids vs phone numbers', () => {
    assert.equal(lids.isLidId('104380590231704@lid'), true);
    assert.equal(lids.isLidId(LID), true);
    assert.equal(lids.isLidId('918882162422@s.whatsapp.net'), false);
    assert.equal(lids.isLidId('918882162422'), false);
    assert.equal(lids.isPhoneId('918882162422@s.whatsapp.net'), true);
    assert.equal(lids.isPhoneId('918882162422'), true);
    assert.equal(lids.bareId('104380590231704:63@lid'), LID);
    assert.equal(lids.formatPhone('918882162422'), '+918882162422');
    assert.equal(lids.isHumanName('ibrahim', LID), true);
    assert.equal(lids.isHumanName(LID, LID), false);
    assert.equal(lids.isHumanName('', LID), false);
  });
});

describe('learn + resolve', () => {
  it('resolves a mention and a sender to a learned name, not the raw lid', () => {
    lids.learn({ lid: LID, name: 'ibrahim' });
    lids.learn({ lid: SENDER_LID, name: 'Embifi' });
    lids.saveMap();

    const text =
      'Name - Jaswinder \nMobile - 8882162422\n\n@104380590231704 Bhai Iski Scooty Bar Bar On Off Ho Rahi Hai..';
    assert.equal(
      lids.rewriteMentions(text),
      'Name - Jaswinder \nMobile - 8882162422\n\n@ibrahim Bhai Iski Scooty Bar Bar On Off Ho Rahi Hai..'
    );

    const stored = {
      id: 'A58F51FE620AFFF5F1E09DA26944FFEF',
      groupId: '120363384708527132@g.us',
      from: SENDER_LID,
      authorName: SENDER_LID,
      text,
      fromMe: false,
      timestamp: '2026-11-17T10:21:51.000Z',
    };
    const resolved = lids.resolveMessage(stored);
    assert.equal(resolved.authorName, 'Embifi');
    assert.ok(resolved.text.includes('@ibrahim'));
    assert.ok(!resolved.text.includes('@104380590231704'));
    // on-disk record is unchanged
    assert.equal(stored.authorName, SENDER_LID);
    assert.ok(stored.text.includes('@104380590231704'));
  });

  it('falls back to +number when a mapping has a phone but no name, and leaves unknown lids alone', () => {
    lids.learn({ lid: '199999999999999', phone: '919876543210' });
    lids.saveMap();
    assert.equal(lids.rewriteMentions('hello @199999999999999'), 'hello @+919876543210');
    assert.equal(lids.displayName('199999999999999').display, '+919876543210');
    assert.equal(lids.displayName('199999999999999').resolved, true);
    assert.equal(lids.rewriteMentions('hello @188888888888888'), 'hello @188888888888888');
    assert.equal(lids.displayName('188888888888888').resolved, false);
  });

  it('keeps an existing human authorName and formats a bare phone sender', () => {
    const named = lids.resolveMessage({
      id: '1',
      groupId: 'g',
      from: SENDER_LID,
      authorName: 'Embifi',
      text: 'hi',
      fromMe: false,
      timestamp: '2026-11-17T10:21:51.000Z',
    });
    assert.equal(named.authorName, 'Embifi');
    const phone = lids.resolveMessage({
      id: '2',
      groupId: 'g',
      from: '918882162422',
      authorName: '918882162422',
      text: 'hi',
      fromMe: false,
      timestamp: '2026-11-17T10:21:51.000Z',
    });
    assert.equal(phone.authorName, '+918882162422');
  });

  it('learns lid+phone from contacts, message keys and phone-share events', () => {
    lids.learnFromContact({
      id: '155555555555555@lid',
      lid: '155555555555555@lid',
      jid: '911112223333@s.whatsapp.net',
      notify: 'Ada',
    });
    lids.learnFromRawMessage({
      key: {
        participant: '166666666666666@lid',
        participantLid: '166666666666666@lid',
        participantPn: '914445556666@s.whatsapp.net',
      },
      pushName: 'Ben',
      message: { extendedTextMessage: { text: 'hi @166666666666666', contextInfo: { mentionedJid: ['166666666666666@lid'] } } },
    });
    lids.learnFromPhoneShare({ lid: '177777777777777@lid', jid: '917778889999@s.whatsapp.net' });
    lids.saveMap();
    assert.equal(lids.displayName('155555555555555').display, 'Ada');
    assert.equal(lids.lookup('155555555555555')?.phone, '911112223333');
    assert.equal(lids.displayName('166666666666666').display, 'Ben');
    assert.equal(lids.rewriteMentions('see @166666666666666'), 'see @Ben');
    assert.equal(lids.displayName('177777777777777').display, '+917778889999');
  });

  it('seeds names from already-stored messages', () => {
    lids.learnFromStoredMessages([
      {
        id: 'x',
        groupId: 'g',
        from: '104380590231704',
        authorName: 'ibrahim',
        text: 'at hub',
        fromMe: false,
        timestamp: '2026-09-07T05:48:53.000Z',
      },
    ]);
    lids.saveMap();
    assert.equal(lids.displayName('104380590231704').display, 'ibrahim');
  });
});
