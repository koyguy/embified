import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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


const PAGE_SIZE = 200;

function formatStamp(iso?: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function mediaLabel(m: ChatMessage) {
  const kinds = [
    ...(m.media || []).map((a) => a.kind),
    ...(m.mediaUnavailable && !m.media?.length ? [m.mediaUnavailable.kind] : []),
  ];
  if (!kinds.length) return '';
  const unique = [...new Set(kinds)];
  return unique.length === 1 ? `${unique[0]} attachment` : `${unique.join(', ')} attachments`;
}

/** Prefill text only — never include media URLs, which are not public links. */
function shareTextFor(m: ChatMessage, groupName?: string) {
  const lines = [
    groupName || 'WhatsApp group',
    `From: ${m.fromMe ? 'Me' : m.authorName || m.from || 'Unknown'}`,
    formatStamp(m.timestamp),
  ];
  if (m.text?.trim()) lines.push('', m.text.trim());
  const media = mediaLabel(m);
  if (media) {
    lines.push('', `[${media} — file not included. Open it in Embified to view.]`);
  }
  const text = lines.join('\n').trim();
  return text.length > 3500 ? `${text.slice(0, 3490)}…` : text;
}

async function shareToWhatsApp(m: ChatMessage, groupName?: string) {
  const text = shareTextFor(m, groupName);
  if (!text) return;
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({ title: groupName || 'WhatsApp message', text });
      return;
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
  }
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function mergeMessages(a: ChatMessage[], b: ChatMessage[]) {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const m of [...a, ...b]) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp) || x.id.localeCompare(y.id));
  return out;
}

function fetchMessages(groupId: string, opts: { limit?: number; before?: string; after?: string; q?: string } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit || PAGE_SIZE));
  if (opts.before) params.set('before', opts.before);
  if (opts.after) opts.after && params.set('after', opts.after);
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  return fetch(`/api/groups/${encodeURIComponent(groupId)}/messages?${params}`).then((r) => r.json());
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
  const [mode, setMode] = useState<'loading' | 'owner' | 'share'>('loading');
  const [shareLabel, setShareLabel] = useState('');
  const [status, setStatus] = useState<WaStatus>(emptyStatus);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [diskLabel, setDiskLabel] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState('');
  const [chatQuery, setChatQuery] = useState('');
  const [debouncedChatQuery, setDebouncedChatQuery] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [token, setToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [webhookPublicUrl, setWebhookPublicUrl] = useState('');
  const [savingCloud, setSavingCloud] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  const stickToBottom = useRef(true);
  const countsRef = useRef<Record<string, number>>({});
  const messagesTailRef = useRef<string | undefined>(undefined);
  const debouncedChatQueryRef = useRef('');
  activeRef.current = activeId;

  // Owner or read-only team share? Decides which endpoints we may call at all.
  useEffect(() => {
    fetch('/api/share/me')
      .then((r) => r.json())
      .then((d) => {
        if (d?.role === 'share') {
          setShareLabel(String(d.label || ''));
          setMode('share');
        } else setMode('owner');
      })
      .catch(() => setMode('owner'));
  }, []);

  const isShare = mode === 'share';

  useEffect(() => {
    if (mode === 'loading') return;
    if (!isShare) {
      fetch('/api/status')
        .then((r) => r.json())
        .then(setStatus)
        .catch(() => {});
    }
    fetch('/api/groups')
      .then((r) => r.json())
      .then((d) => setGroups(d.groups || []))
      .catch(() => {});

    if (!isShare) {
      fetch('/api/disk')
        .then((r) => r.json())
        .then((d) => {
          if (d?.ok && d.human) {
            setDiskLabel(`${d.human.vault} of ${d.human.quota}`);
          }
        })
        .catch(() => {});
    }

    let cancelled = false;
    let esWorked = false;
    let es: EventSource | null = new EventSource('/api/events');
    let pollAbort: AbortController | null = null;

    const applyEvent = (event: string, data: any) => {
      if (event === 'status') {
        try {
          setStatus(data);
        } catch {
          /* ignore */
        }
        return;
      }
      if (event === 'groups') {
        if (!Array.isArray(data)) return;
        const id = activeRef.current;
        const before = id ? countsRef.current[id] : undefined;
        const now = id ? data.find((g: GroupSummary) => g.id === id)?.messageCount : undefined;
        setGroups(data);
        if (id && now !== undefined && now !== before && !debouncedChatQueryRef.current) {
          const last = messagesTailRef.current;
          fetchMessages(id, last ? { after: last } : { limit: PAGE_SIZE })
            .then((d) => {
              if (activeRef.current !== id) return;
              setMessages((prev) => mergeMessages(prev, d.messages || []));
              if (!last) setHasMore(!!d.hasMore);
            })
            .catch(() => {});
        }
        return;
      }
      if (event === 'message') {
        const msg = data as ChatMessage;
        setMessages((prev) => {
          if (!activeRef.current || msg.groupId !== activeRef.current) return prev;
          if (prev.some((m) => m.id === msg.id)) return prev;
          if (debouncedChatQueryRef.current) return prev;
          return [...prev, msg];
        });
        return;
      }
      if (event === 'history') {
        const id = activeRef.current;
        if (id && (!data?.groups?.length || data.groups.includes(id))) {
          fetchMessages(id, { q: debouncedChatQueryRef.current, limit: PAGE_SIZE })
            .then((d) => {
              if (activeRef.current === id) {
                setMessages(d.messages || []);
                setHasMore(!!d.hasMore);
                if (debouncedChatQueryRef.current) setSearchTotal(d.total ?? null);
                stickToBottom.current = true;
              }
            })
            .catch(() => {});
        }
      }
    };

    const listen = (target: EventSource) => {
      for (const ev of ['status', 'groups', 'message', 'history']) {
        target.addEventListener(ev, (e) => {
          esWorked = true;
          try {
            applyEvent(ev, JSON.parse((e as MessageEvent).data));
          } catch {
            /* ignore */
          }
        });
      }
    };
    listen(es);

    const startLongPoll = () => {
      if (cancelled || pollAbort) return;
      pollAbort = new AbortController();
      const signal = pollAbort.signal;
      (async () => {
        while (!cancelled && !signal.aborted) {
          try {
            const r = await fetch('/api/events/poll?wait=25000', { signal });
            if (!r.ok) {
              await new Promise((res) => setTimeout(res, 3000));
              continue;
            }
            const d = await r.json();
            for (const ev of d.events || []) applyEvent(ev.event, ev.data);
          } catch (e: any) {
            if (cancelled || signal.aborted) return;
            await new Promise((res) => setTimeout(res, 2000));
          }
        }
      })();
    };

    const fallback = window.setTimeout(() => {
      if (cancelled || esWorked) return;
      es?.close();
      es = null;
      startLongPoll();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
      es?.close();
      pollAbort?.abort();
    };
  }, [mode]);

  useEffect(() => {
    countsRef.current = Object.fromEntries(groups.map((g) => [g.id, g.messageCount]));
  }, [groups]);
  useEffect(() => {
    messagesTailRef.current = messages.length ? messages[messages.length - 1].id : undefined;
  }, [messages]);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedChatQuery(chatQuery), 250);
    return () => window.clearTimeout(t);
  }, [chatQuery]);
  useEffect(() => {
    debouncedChatQueryRef.current = debouncedChatQuery;
  }, [debouncedChatQuery]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      setHasMore(false);
      setSearchTotal(null);
      setChatQuery('');
      setDebouncedChatQuery('');
      return;
    }
    const id = activeId;
    const q = debouncedChatQuery;
    let cancelled = false;
    fetchMessages(id, { q, limit: PAGE_SIZE })
      .then((d) => {
        if (cancelled || activeRef.current !== id) return;
        setMessages(d.messages || []);
        setHasMore(!!d.hasMore);
        setSearchTotal(q.trim() ? d.total ?? (d.messages || []).length : null);
        stickToBottom.current = !q.trim();
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    if (!isShare) fetch(`/api/groups/${encodeURIComponent(id)}/read`, { method: 'POST' }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeId, isShare, debouncedChatQuery]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages.length, activeId]);

  const loadOlder = useCallback(() => {
    const id = activeRef.current;
    const el = msgsRef.current;
    if (!id || !hasMore || loadingMore || !messages[0]) return;
    setLoadingMore(true);
    const prevHeight = el?.scrollHeight || 0;
    const before = messages[0].id;
    fetchMessages(id, { before, q: debouncedChatQuery, limit: PAGE_SIZE })
      .then((d) => {
        const incoming: ChatMessage[] = d.messages || [];
        setMessages((prev) => mergeMessages(incoming, prev));
        setHasMore(!!d.hasMore);
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevHeight;
        });
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [hasMore, loadingMore, messages, debouncedChatQuery]);

  const onMsgsScroll = () => {
    const el = msgsRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 80) loadOlder();
  };


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

  const resetLink = async () => {
    if (resetting) return;
    if (!window.confirm('Move the current WhatsApp session aside and show a new QR? (Nothing is deleted.)')) return;
    setResetting(true);
    setResetError(null);
    try {
      const res = await fetch('/api/whatsapp/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'reset' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setResetError(data.error || `Reset failed (${res.status})`);
      else if (data.status) setStatus(data.status);
    } catch {
      setResetError('Reset failed — check the server logs');
    } finally {
      setResetting(false);
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
          webhookPublicUrl: webhookPublicUrl.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.status) setStatus(data.status);
      setToken('');
      setAppSecret('');
      setWebhookPublicUrl('');
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

  if (mode === 'loading') {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="logo" style={{ margin: '0 auto 12px' }}>
            E
          </div>
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  if (!isShare && !status.connected) {
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
              {status.waState === 'logged_out' && (
                <div
                  role="alert"
                  style={{
                    background: '#3b1d1d',
                    border: '1px solid #b54848',
                    color: '#ffd9d9',
                    borderRadius: 10,
                    padding: '12px 14px',
                    margin: '12px 0',
                    textAlign: 'left',
                    fontSize: 14,
                  }}
                >
                  <strong>WhatsApp logged this vault out</strong>
                  {status.waStateSince ? ` (since ${new Date(status.waStateSince).toLocaleString()})` : ''}. New
                  group messages are not being captured. Relink to resume — WhatsApp re-sends recent history on a
                  new link and it is merged without duplicates.
                  <div style={{ marginTop: 10 }}>
                    <button type="button" className="primary" disabled={resetting} onClick={resetLink}>
                      {resetting ? 'Resetting…' : 'Reset & show QR'}
                    </button>
                  </div>
                  {resetError && <div style={{ marginTop: 8 }}>{resetError}</div>}
                </div>
              )}
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
                Official <strong>WhatsApp Cloud API</strong> (no Baileys). Meta POSTs inbound 1:1 and group
                messages to this server. Need HTTPS? See <a href="/cloud-setup">/cloud-setup</a>. The number must be a Cloud API / Official Business Account
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

                <label>
                  Public HTTPS origin (Cloudflare Tunnel URL)
                  <input
                    type="url"
                    autoComplete="off"
                    placeholder={status.webhookPublicUrl || 'https://your-tunnel.example.com'}
                    value={webhookPublicUrl}
                    onChange={(e) => setWebhookPublicUrl(e.target.value)}
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
          {isShare ? (
            <div className="me share-tag" title="Read-only shared view">
              <strong>Shared view · read-only</strong>
              {shareLabel}
            </div>
          ) : (
            <div className="me">
              <strong>
                <span className="dot on" />
                {provider === 'cloud' ? 'Cloud API' : 'Linked'}
              </strong>
              {status.me?.name || status.me?.id || 'Business number'}
            </div>
          )}
        </div>
        {!isShare && (
          <div className="provider-bar">
            <ProviderSwitch provider={provider} disabled={switching} onPick={pickProvider} />
          </div>
        )}
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
              {isShare
                ? 'No shared groups to show.'
                : provider === 'cloud'
                ? 'No Cloud API conversations yet. Incoming webhooks will show up here.'
                : 'No groups yet. Add this number to a WhatsApp group — messages will show up here automatically.'}
            </p>
          )}
          {filtered.map((g) => (
            <button
              key={g.id}
              className={`group-row ${g.id === activeId ? 'active' : ''}`}
              onClick={() => {
                if (g.id !== activeId) {
                  setChatQuery('');
                  setDebouncedChatQuery('');
                }
                setActiveId(g.id);
              }}
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
        {isShare ? (
          <div className="foot">
            <span>{groups.length} shared group{groups.length === 1 ? '' : 's'}</span>
            <a className="disk-meter" href="/auth/logout">
              Leave
            </a>
          </div>
        ) : (
        <div className="foot">
          <span>{groups.length} saved</span>
          {diskLabel && (
            <a className="disk-meter" href="/api/disk" title="Vault usage (JSON)">
              {diskLabel}
            </a>
          )}
          <span>{provider === 'cloud' ? 'official · Cloud API' : 'local · linked device'}</span>
        </div>
        )}
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
              <button type="button" className="back" aria-label="Back to groups" onClick={() => setActiveId(null)}>
                ‹
              </button>
              <button
                type="button"
                className="avatar"
                style={{ border: 0, color: 'inherit', cursor: 'pointer' }}
                onClick={() => setActiveId(null)}
              >
                {initials(active.name)}
              </button>
              <div className="chat-head-copy">
                <h1>{active.name}</h1>
                <p>
                  {active.kind === 'dm' ? '1:1 · ' : ''}
                  {active.memberCount ? `${active.memberCount} members · ` : ''}
                  {searchTotal !== null ? `${searchTotal} match${searchTotal === 1 ? '' : 'es'}` : `${active.messageCount} saved`}
                </p>
              </div>
              <div className="chat-head-search">
                <input
                  type="search"
                  placeholder="Search messages"
                  value={chatQuery}
                  onChange={(e) => setChatQuery(e.target.value)}
                  aria-label="Search messages in this chat"
                />
              </div>
            </div>
            <div className="msgs" ref={msgsRef} onScroll={onMsgsScroll}>
              {hasMore && (
                <button type="button" className="load-more" onClick={loadOlder} disabled={loadingMore}>
                  {loadingMore ? 'Loading earlier messages…' : 'Load earlier messages'}
                </button>
              )}
              {debouncedChatQuery.trim() && messages.length === 0 && (
                <div className="day">No messages matched “{debouncedChatQuery.trim()}”</div>
              )}
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
                      {m.mediaUnavailable && !m.media?.length ? (
                        <div className="body" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                          📎 {m.mediaUnavailable.kind} not downloaded
                        </div>
                      ) : null}
                      {m.text ? <div className="body">{m.text}</div> : null}
                      <div className="meta">
                        <button
                          type="button"
                          className="share-wa"
                          aria-label="Share to WhatsApp"
                          title="Share to WhatsApp"
                          onClick={() => shareToWhatsApp(m, active.name)}
                        >
                          Share
                        </button>
                        <span>{formatTime(m.timestamp)}</span>
                      </div>
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
