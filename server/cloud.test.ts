import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conversationFromMessage, parseWebhookPayload } from './cloud.ts';

describe('conversationFromMessage', () => {
  it('uses group_id for Cloud API group messages', () => {
    const convo = conversationFromMessage(
      { from: '16505551234', group_id: 'grp-abc', id: 'wamid.1' },
      [{ wa_id: '16505551234', profile: { name: 'Sheena' } }]
    );
    assert.equal(convo.id, 'grp-abc');
    assert.equal(convo.kind, 'group');
    assert.equal(convo.authorName, 'Sheena');
  });

  it('uses dm: prefix for 1:1 chats', () => {
    const convo = conversationFromMessage(
      { from: '16505551234', id: 'wamid.2' },
      [{ wa_id: '16505551234', profile: { name: 'Sheena' } }]
    );
    assert.equal(convo.id, 'dm:16505551234');
    assert.equal(convo.kind, 'dm');
    assert.equal(convo.name, 'Sheena');
  });
});

describe('parseWebhookPayload', () => {
  it('pulls inbound messages out of a Cloud API envelope', () => {
    const items = parseWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: '15550783881' },
                contacts: [{ wa_id: '16505551234', profile: { name: 'Sheena' } }],
                messages: [
                  {
                    from: '16505551234',
                    group_id: 'grp-1',
                    id: 'wamid.HBg',
                    timestamp: '1710000000',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].message.id, 'wamid.HBg');
    assert.equal(items[0].displayPhone, '15550783881');
  });

  it('ignores non-whatsapp payloads', () => {
    assert.deepEqual(parseWebhookPayload({ object: 'page' }), []);
  });
});
