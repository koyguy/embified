import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, GroupSummary, WaStatus } from './types';

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

export default function App() {
  const [status, setStatus] = useState<WaStatus>({ connected: false, qr: null, me: null });
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState('');
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

  if (!status.connected) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="logo" style={{ margin: '0 auto 12px' }}>
            E
          </div>
          <h1>Embified</h1>
          <p>
            WhatsApp group inbox for your business number. Scan the QR with{' '}
            <strong>WhatsApp → Linked devices</strong> on the phone that’s added to the groups
            you want to capture.
          </p>
          {status.qr ? (
            <div className="qr">
              <img src={status.qr} alt="Scan QR to link WhatsApp" />
            </div>
          ) : (
            <p style={{ marginTop: 24 }}>
              <span className="dot off" /> Waiting for WhatsApp…
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
              Linked
            </strong>
            {status.me?.name || status.me?.id || 'Business number'}
          </div>
        </div>
        <div className="search">
          <input
            placeholder="Search groups"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="group-list">
          {filtered.length === 0 && (
            <p style={{ padding: 20, color: 'var(--muted)', fontSize: 14 }}>
              No groups yet. Add this number to a WhatsApp group — messages will show up here
              automatically.
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
          <span>{groups.length} groups saved</span>
          <span>local · Embified</span>
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
                Select a group on the left. Anything posted in groups this business number
                belongs to is captured and stored here — text and media.
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
                  {active.memberCount ? `${active.memberCount} members · ` : ''}
                  {active.messageCount} saved
                </p>
              </div>
            </div>
            <div className="msgs">
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const showDay =
                  !prev || formatDay(prev.timestamp) !== formatDay(m.timestamp);
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
