# Public site (signup chat + setup guides)

The public, stranger-facing pages live on a **static site**, not on anyone's vault:

| Page | URL |
| --- | --- |
| Signup chat assistant (index) | https://koyguy.github.io/embified/ |
| Checklist quest (7 levels) | https://koyguy.github.io/embified/quest.html |
| Cloud Shell launcher script | https://koyguy.github.io/embified/install/oci-launch.sh |
| Classic wizard | https://koyguy.github.io/embified/create-vault.html |
| Cloud API guide | https://koyguy.github.io/embified/cloud-setup.html |
| Home box guide | https://koyguy.github.io/embified/home-setup.html |

Source: [`site/`](../site/) — plain HTML/CSS/JS, no build step, all links relative so the
site works under the `/embified/` base path and at a domain root.
Published by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push
to `main` that touches `site/**` (Settings → Pages → Source: **GitHub Actions**, HTTPS enforced).

## Signup chat (`index.html`, `chat.js`, `chat.css`)

A **scripted** chat (no AI, no API, no network calls). The script is the `N` node table in
`site/chat.js`: each node has bot bubbles, quick replies and an optional text input. State
(transcript, node, XP, badges, region, vault link, referral) lives in `localStorage`
(`embified.chat.v1`), so customers resume where they left off. `?ref=` works as before (+50 XP)
and shares the invite code with the checklist quest. `?fast=1` disables typing delays (tests).

Flow: greet → path (Oracle / home box / Cloud API) → card pre-check → home region →
Oracle signup (opens `signup.cloud.oracle.com`; "I'm stuck" branches: card declined, email,
"Error processing transaction", region, VPN; "What's this charge?") → sign in + open Cloud
Shell (`>_` icon; Oracle has no documented deep link that opens Cloud Shell) → copy the
one-liner → paste vault link (validated) → open vault + scan QR → confetti, badge, invite link.
A ❓ FAQ is available any time and returns to the current step.

The one-liner runs [`install/oci-launch.sh`](../site/install/oci-launch.sh) — a copy of
[`scripts/oci-cloudshell/oci-launch.sh`](../scripts/oci-cloudshell/oci-launch.sh) (keep them
identical). See that folder's README for what it does and how it's tested.

Headless test: `npx -y -p playwright@1.48.2 node scripts/site-e2e/chat.e2e.mjs [--shots DIR]`.

## Vault side

A vault serves only the private inbox and login. These old public paths now answer
**301** to the static site, keeping the query string (so `?ref=` invite codes survive):

| Vault path | Redirects to |
| --- | --- |
| `/start`, `/vault` | `${PUBLIC_SITE_URL}/` |
| `/create-vault` | `${PUBLIC_SITE_URL}/create-vault.html` |
| `/cloud-setup` | `${PUBLIC_SITE_URL}/cloud-setup.html` |
| `/home-setup` | `${PUBLIC_SITE_URL}/home-setup.html` |

`PUBLIC_SITE_URL` defaults to `https://koyguy.github.io/embified` (see `server/public-site.ts`);
it also drives the login page's "New here?" link. Public without a session:
`/health`, `/login`, `/auth/*`, `/api/whatsapp/webhook`, `/api/digest/health`.

## Config — `site/config.js`

```js
window.EMBIFIED_SITE = {
  SITE_URL: 'https://koyguy.github.io/embified', // invite/referral links: SITE_URL + '/?ref=<code>'
  ANALYTICS_URL: '',                             // empty = no analytics, no network calls
};
```

### Funnel analytics (optional)

Static hosting can't store events, so `track()` in `site/start.js` is a no-op unless
`ANALYTICS_URL` is an `https://` URL. When set, each step POSTs JSON
`{event, cid, level, ref}` (random client id, no PII) with `mode: 'cors'`, so the endpoint must
answer the CORS preflight for the site's origin. Any small serverless function / form backend works.
The old vault collector (`POST /api/funnel/event`, `GET /api/funnel/stats`) remains in the
code but sits behind the auth wall.

## Custom domain later

1. Add `site/CNAME` containing just the domain (e.g. `embified.example`).
2. DNS: `CNAME embified.example → koyguy.github.io` (or the apex A/AAAA records GitHub documents).
3. Settings → Pages → Custom domain → enter it, wait for the cert, tick **Enforce HTTPS**.
4. Update `SITE_URL` in `site/config.js` and set `PUBLIC_SITE_URL=https://embified.example`
   on vaults (systemd env / `.env`) so redirects and the login link follow.
