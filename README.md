# Embified

Local-first **WhatsApp group inbox**. Capture conversations from a business number and keep the history on your machine.

Pick one implementation in the app (or set `WA_PROVIDER`):

| Implementation | How it connects | Best for |
| --- | --- | --- |
| **Linked device (Baileys)** | Unofficial multi-device client. Scan a QR like WhatsApp Web. | Any regular / Business *app* number that is already in groups. |
| **Official Cloud API** | Meta Graph API + HTTPS webhooks. | A Cloud API phone number (WhatsApp Business Platform). |

Both write into the same local store (`./data`). Only one is active at a time.

## Intent

- **System of record for group chats.** Persist text and media so history does not die with a handset.
- **Shared inbox, not another phone.** Anyone with the app can read saved conversations.
- **Local by default.** Messages, media, and the Baileys session stay on disk.

## Linked device (Baileys)

Unofficial companion. WhatsApp may disconnect it.

1. Choose **Linked device** in the UI.
2. Scan the QR: **WhatsApp → Linked devices → Link a device**.
3. Groups that number belongs to appear as messages arrive.

`syncFullHistory` is off — you get traffic after this device is linked, not years of backfill. DMs and Status are ignored.

Session files live in `./auth_info` (gitignored). Relink by deleting that folder and scanning again.

## Official Cloud API

Meta hosts the WhatsApp connection. Embified is only a webhook receiver + inbox.

**Requirements**

- Meta developer app with WhatsApp product
- Business phone number **on Cloud API** (not a normal “linked devices” session)
- Official groups need an [Official Business Account](https://developers.facebook.com/documentation/business-messaging/whatsapp/official-business-accounts) and Groups API eligibility. 1:1 customer chats work without that.

**`.env`**

```bash
WA_PROVIDER=cloud
WHATSAPP_TOKEN=           # permanent system-user token
WHATSAPP_PHONE_NUMBER_ID= # App Dashboard → WhatsApp → API Setup
WHATSAPP_VERIFY_TOKEN=    # any secret you invent
WHATSAPP_APP_SECRET=      # optional, verifies webhook signatures
```

**Webhook**

The callback must be public HTTPS. With the app running:

```bash
cloudflared tunnel --url http://localhost:3002
```

In Meta App Dashboard → WhatsApp → Configuration:

- Callback URL: `https://<tunnel>/api/whatsapp/webhook`
- Verify token: same as `WHATSAPP_VERIFY_TOKEN`
- Subscribe to `messages`
- For groups, also `group_lifecycle_update`, `group_participants_update`, `group_settings_update`

Inbound group messages include `group_id`. 1:1 chats are stored as `dm:<wa_id>`.

## Run locally

```bash
git clone https://github.com/koyguy/embified.git
cd embified
cp .env.example .env
npm install
npm run dev
```

Open [http://localhost:3002](http://localhost:3002) and pick an implementation.

## Host it (Mac not required)

WhatsApp needs a process that **never sleeps**. Free tiers that spin down (Render free, most serverless) drop the linked-device session.

**Best free always-on:** [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) ARM VM (you create the account; 24/7 VM + disk).

**Easiest paid-but-tiny:** [Fly.io](https://fly.io) (~$2–6/mo for 512 MB, stays up, HTTPS included).

```bash
fly launch --copy-config --yes
fly volumes create embified_data --size 1 --region bom --yes
fly deploy
fly apps open
```

Then open the public URL and scan the QR once. Session + media persist on the `/data` volume.

**Render free** (`render.yaml`) will sleep after idle and is a poor fit for Baileys. Persistent disk on Render is not free.

Do **not** commit `auth_info/` or `data/`. Set Cloud API secrets as platform env vars, not in git.

| Script | What it does |
| --- | --- |
| `npm run dev` | API + Vite inbox (default port **3002**) |
| `npm run build` | Production frontend build |
| `npm start` | Serve the built app |
| `npm test` | Webhook/parser unit tests |

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port |
| `WA_PROVIDER` | `baileys` | Initial implementation if `data/settings.json` is missing |
| `AUTH_DIR` | `./auth_info` | Baileys session (do not commit) |
| `DATA_DIR` | `./data` | Saved chats, media, settings (do not commit) |
| `LOG_LEVEL` | `info` | Pino log level |
| `MEDIA_MAX_BYTES` | `15728640` | Skip media larger than this |

The UI choice is saved in `./data/settings.json` and wins over `WA_PROVIDER` on the next start.

## Layout

```
server.ts             HTTP API, SSE, Cloud API webhook, Vite
server/wa.ts          start / switch provider
server/baileys.ts     unofficial linked-device bridge
server/cloud.ts       official Graph API + webhooks
server/store.ts       local JSON + media
src/                  inbox UI + implementation switcher
```

## Safety

- Do **not** commit `auth_info/`, `data/`, or `.env`.
- `WHATSAPP_TOKEN` is a live credential for the Cloud API number.
- `auth_info/` is a live login for the linked-device number.
- Use Cloud API if you need a supported, contract-backed integration. Use Baileys if the number is only on the WhatsApp app and you accept unofficial-client risk.
