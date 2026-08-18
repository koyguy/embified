# Embified

WhatsApp-style **group inbox**. If your business number is added to a group, every message in that group is captured, saved, and shown here.

## Run locally

```bash
cd embified
npm install
npm run dev
```

Open http://localhost:3002

1. Scan the QR: **WhatsApp → Linked devices → Link a device** (use the business phone).
2. Groups appear as the number is added / messages arrive.
3. Click a group to read the full saved history (text + media).

Data lives in `./data` (messages + media). Session in `./auth_info` — don’t commit either.

## Share online (free)

With the app running:

```bash
cloudflared tunnel --url http://localhost:3002
```

Share the `https://….trycloudflare.com` URL. Mac must stay awake.

Port default: **3002** (`PORT` env).
