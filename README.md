# Embified

Local-first **WhatsApp group inbox**. Link a business number, capture every group it belongs to, and keep the history on your machine.

WhatsApp groups are where a lot of operational work actually happens — drivers, partners, collections, support. Those threads live on a phone. Embified treats the business number as an archive source: it joins as a linked device, listens to groups only, and shows a WhatsApp-style inbox you can search and share with the team.

## Intent

- **System of record for group chats.** Persist text and media so history does not die with a handset or a cleared chat.
- **Shared inbox, not another phone.** Anyone with the app can read saved groups without sitting on the linked device.
- **Local by default.** Messages, media, and the WhatsApp session stay on disk (`./data`, `./auth_info`). Nothing is uploaded to a third-party backend.
- **Groups only.** Direct messages and Status are ignored.

This is an unofficial companion (Baileys / multi-device). It is an inbox and archive, not a bulk sender and not the official WhatsApp Business API.

## How it works

1. Run the app and scan the QR: **WhatsApp → Linked devices → Link a device** (use the business phone).
2. Embified syncs groups that number is in.
3. New group messages (text, images, video, audio, documents, stickers) are saved locally and streamed into the UI.
4. Open a group to read the full saved history.

```
WhatsApp (business number)
        │  linked device
        ▼
   server/wa.ts          capture groups, download media
        │
   server/store.ts       ./data  (JSON + media files)
        │
   Express + Vite UI     http://localhost:3002
        │
   EventSource           live status / groups / messages
```

## Run locally

```bash
git clone https://github.com/koyguy/embified.git
cd embified
npm install
npm run dev
```

Open [http://localhost:3002](http://localhost:3002).

| Script | What it does |
| --- | --- |
| `npm run dev` | API + Vite inbox (default port **3002**) |
| `npm run build` | Production frontend build |
| `npm start` | Serve the built app |

Copy `.env.example` to `.env` if you want to change paths or the port.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port |
| `AUTH_DIR` | `./auth_info` | WhatsApp session (do not commit) |
| `DATA_DIR` | `./data` | Saved groups, messages, media (do not commit) |
| `LOG_LEVEL` | `info` | Pino log level |
| `MEDIA_MAX_BYTES` | `15728640` | Skip media larger than this |

## Share the inbox

The Mac has to stay awake and the process has to keep running:

```bash
cloudflared tunnel --url http://localhost:3002
```

Share the `https://….trycloudflare.com` URL. Anyone with the link can read whatever this instance has stored.

## Layout

```
server.ts          HTTP API, SSE, Vite middleware
server/wa.ts       WhatsApp link, QR, group listener
server/store.ts    Local JSON + media store
src/               Inbox UI
```

## Safety

- Do **not** commit `auth_info/`, `data/`, or `.env`. They are gitignored. The session file is a live login to the business WhatsApp.
- Relink: stop the app, delete `auth_info`, start again, scan a new QR.
- WhatsApp may disconnect unofficial clients. The server reconnects unless you are logged out.

## License

Private project unless you add a license file. Use at your own risk; unofficial WhatsApp clients can be blocked.
