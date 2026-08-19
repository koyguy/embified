import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, GroupSummary, WaProvider, WaStatus } from './types';

function formatTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
}

const emptyStatus: WaStatus = {
  connected: false,
  qr: null,
  me: null,
  provider: 'baileys',
  cloudConfigured: false,
  webhookPath: '/api/whatsapp/webhook',
};

function ProviderSwitch({
  provider,
  disabled,
  onPick,
}: {
  provider: WaProvider;
  disabled?: boolean;
  onPick: (p: WaProvider) => void;
}) {
  return (
    <div className="provider-switch" role="tablist" aria-label="WhatsApp implementation">
      <button
        type="button"
        role="tab"
        className={provider === 'baileys' ? 'on' : ''}
        disabled={disabled}
        onClick={() => onPick('baileys')}
      >
        Linked device
      </button>
      <button
        type="button"
        role="tab"
        className={provider === 'cloud' ? 'on' : ''}
        disabled={disabled}
        onClick={() => onPick('cloud')}
      >
        Official Cloud API
      </button>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<WaStatus>(emptyStatus);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState('');
  const [switching, setSwitching] = useState(false);
  const [token, setToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [savingCloud, setSavingCloud] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
    fetch('/api/groups')
      .then((r) => r.json())
      .then((d) => setGroups(d.groups || []))
      .catch(() => {});

    const es = new EventSource('/api/events');
    es.addEventListener('status', (ev) => {
      try {
        setStatus(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('groups', (ev) => {
      try {
        setGroups(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data) as ChatMessage;
        setMessages((prev) => {
          if (!activeRef.current || msg.groupId !== activeRef.current) return prev;
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    fetch(`/api/groups/${encodeURIComponent(activeId)}/messages`)
      .then((r) => r.json())
      .then((d) => setMessages(d.messages || []))
      .catch(() => setMessages([]));
    fetch(`/api/groups/${encodeURIComponent(activeId)}/read`, { method: 'POST' }).catch(() => {});
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, activeId]);

  const pickProvider = async (provider: WaProvider) => {
    if (provider === status.provider || switching) return;
    setSwitching(true);
    setActiveId(null);
    try {
      const res = await fetch('/api/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (data.status) setStatus(data.status);
    } catch {
      /* status stream will catch up */
    } finally {
      setSwitching(false);
    }
  };

  const saveCloud = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCloud(true);
    try {
      const res = await fetch('/api/cloud-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim() || undefined,
          phoneNumberId: phoneNumberId.trim() || undefined,
          appSecret: appSecret.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.status) setStatus(data.status);
      setToken('');
      setAppSecret('');
    } catch {
      /* status stream will catch up */
    } finally {
      setSavingCloud(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.lastMessage || '').toLowerCase().includes(q)
    );
  }, [groups, query]);

  const active = groups.find((g) => g.id === activeId);
  const provider = status.provider || 'baileys';

  if (!status.connected) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="logo" style={{ margin: '0 auto 12px' }}>
            E
          </div>
          <h1>Embified</h1>
          <p>Choose how this inbox talks to WhatsApp.</p>
          <ProviderSwitch provider={provider} disabled={switching} onPick={pickProvider} />

          {provider === 'baileys' ? (
            <>
              <p>
                Unofficial multi-device bridge. Scan the QR with{' '}
                <strong>WhatsApp → Linked devices</strong> on the phone that’s in the groups
                you want to capture.
              </p>
              {status.qr ? (
                <div className="qr">
                  <img src={status.qr} alt="Scan QR to link WhatsApp" />
                </div>
              ) : (
                <p style={{ marginTop: 24 }}>
                  <span className="dot off" /> {switching ? 'Switching…' : 'Waiting for WhatsApp…'}
                  {status.error && (
                    <>
                      <br />
                      {status.error}
                    </>
                  )}
                </p>
              )}
              <p style={{ fontSize: 13 }}>
                All group chats this number is in will appear here and stay saved on this machine.
              </p>
            </>
          ) : (
            <>
              <p>
                Official <strong>WhatsApp Cloud API</strong>. Meta POSTs inbound 1:1 and group
                messages to this server. The number must be a Cloud API / Official Business Account
                number — not a regular WhatsApp Business app login.
              </p>
              {status.error && (
                <p style={{ marginTop: 16 }}>
                  <span className="dot off" /> {status.error}
                </p>
              )}
              <form className="setup" onSubmit={saveCloud}>
                <p>
                  Meta hosts the number. Embified only receives webhooks. Paste the Cloud API
                  values from <strong>developers.facebook.com → your app → WhatsApp → API Setup</strong>.
                </p>
                <label>
                  Access token
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={status.hasToken ? 'Saved — paste to replace' : 'WHATSAPP_TOKEN'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
                <label>
                  Phone number ID
                  <input
                    type="text"
                    autoComplete="off"
                    placeholder={status.hasPhoneNumberId ? 'Saved — paste to replace' : 'WHATSAPP_PHONE_NUMBER_ID'}
                    value={phoneNumberId}
                    onChange={(e) => setPhoneNumberId(e.target.value)}
                  />
                </label>
                <label>
                  App secret (optional)
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="WHATSAPP_APP_SECRET"
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                  />
                </label>
                <button type="submit" className="primary" disabled={savingCloud}>
                  {savingCloud ? 'Saving…' : 'Save and connect'}
                </button>
                <p>
                  Verify token (paste this into Meta’s webhook UI):
                  <br />
                  <code>{status.verifyToken || 'will be generated on switch'}</code>
                </p>
                <p>
                  Callback URL (must be public HTTPS):
                  <br />
                  <code>{status.webhookUrl || status.webhookPath}</code>
                </p>
                <p>
                  Subscribe to <code>messages</code>. For official groups also{' '}
                  <code>group_lifecycle_update</code> and <code>group_participants_update</code>.
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${activeId ? 'has-chat' : ''}`}>
      <aside className="sidebar">
        <div className="side-head">
          <div className="brand">
            <div className="logo">E</div>
            <div>
              Embified
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>
                group inbox
              </div>
            </div>
          </div>
          <div className="me">
            <strong>
              <span className="dot on" />
              {provider === 'cloud' ? 'Cloud API' : 'Linked'}
            </strong>
            {status.me?.name || status.me?.id || 'Business number'}
          </div>
        </div>
        <div className="provider-bar">
          <ProviderSwitch provider={provider} disabled={switching} onPick={pickProvider} />
        </div>
        <div className="search">
          <input
            placeholder="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="group-list">
          {filtered.length === 0 && (
            <p style={{ padding: 20, color: 'var(--muted)', fontSize: 14 }}>
              {provider === 'cloud'
                ? 'No Cloud API conversations yet. Incoming webhooks will show up here.'
                : 'No groups yet. Add this number to a WhatsApp group — messages will show up here automatically.'}
            </p>
          )}
          {filtered.map((g) => (
            <button
              key={g.id}
              className={`group-row ${g.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(g.id)}
            >
              <div className="avatar">{initials(g.name || 'G')}</div>
              <div className="g-main">
                <div className="g-top">
                  <div className="g-name">{g.name}</div>
                  <div className="g-time">{formatTime(g.lastAt)}</div>
                </div>
                <div className="g-bot">
                  <div className="g-prev">{g.lastMessage || 'No messages yet'}</div>
                  {g.unread > 0 && <div className="badge">{g.unread}</div>}
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="foot">
          <span>{groups.length} saved</span>
          <span>{provider === 'cloud' ? 'official · Cloud API' : 'local · linked device'}</span>
        </div>
      </aside>

      <section className="chat">
        {!active ? (
          <div className="empty-chat">
            <div>
              <div className="logo" style={{ margin: '0 auto 16px', width: 56, height: 56, fontSize: 24 }}>
                E
              </div>
              <h2>Keep every group message</h2>
              <p>
                Select a conversation on the left. Incoming messages from the selected
                implementation are captured and stored here — text and media.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="chat-head">
              <button
                type="button"
                className="avatar"
                style={{ border: 0, color: 'inherit', cursor: 'pointer' }}
                onClick={() => setActiveId(null)}
              >
                {initials(active.name)}
              </button>
              <div>
                <h1>{active.name}</h1>
                <p>
                  {active.kind === 'dm' ? '1:1 · ' : ''}
                  {active.memberCount ? `${active.memberCount} members · ` : ''}
                  {active.messageCount} saved
                </p>
              </div>
            </div>
            <div className="msgs">
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const showDay = !prev || formatDay(prev.timestamp) !== formatDay(m.timestamp);
                return (
                  <React.Fragment key={m.id}>
                    {showDay && <div className="day">{formatDay(m.timestamp)}</div>}
                    <div className={`bubble ${m.fromMe ? 'out' : 'in'}`}>
                      {!m.fromMe && <div className="author">{m.authorName}</div>}
                      {m.media?.map((att) => (
                        <div className="media" key={att.id}>
                          {(att.kind === 'image' || att.kind === 'sticker') && (
                            <a href={att.url} target="_blank" rel="noreferrer">
                              <img src={att.url} alt={att.fileName} />
                            </a>
                          )}
                          {att.kind === 'video' && <video src={att.url} controls />}
                          {att.kind === 'audio' && <audio src={att.url} controls />}
                          {(att.kind === 'document' || att.kind === 'other') && (
                            <a className="file-link" href={att.url} target="_blank" rel="noreferrer">
                              📄 {att.fileName}
                            </a>
                          )}
                        </div>
                      ))}
                      {m.text ? <div className="body">{m.text}</div> : null}
                      <div className="meta">{formatTime(m.timestamp)}</div>
                    </div>
                  </React.Fragment>
                );
              })}
              <div ref={bottomRef} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
