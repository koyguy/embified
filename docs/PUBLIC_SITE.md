# Public site (signup quest + setup guides)

The public, stranger-facing pages live on a **static site**, not on anyone's vault:

| Page | URL |
| --- | --- |
| Guided signup quest (index) | https://koyguy.github.io/embified/ |
| Classic wizard | https://koyguy.github.io/embified/create-vault.html |
| Cloud API guide | https://koyguy.github.io/embified/cloud-setup.html |
| Home box guide | https://koyguy.github.io/embified/home-setup.html |

Source: [`site/`](../site/) — plain HTML/CSS/JS, no build step, all links relative so the
site works under the `/embified/` base path and at a domain root.
Published by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push
to `main` that touches `site/**` (Settings → Pages → Source: **GitHub Actions**, HTTPS enforced).

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
