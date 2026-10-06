import type { Express, Request, Response } from 'express';

/**
 * The public signup/marketing pages (quest, classic wizard, setup guides) live on a static
 * site (GitHub Pages, see site/ and docs/PUBLIC_SITE.md). A vault only serves the private
 * inbox + login. Old vault URLs 301 to the matching static page so shared links keep working.
 */
export const DEFAULT_PUBLIC_SITE_URL = 'https://koyguy.github.io/embified';

/** Vault path → page on the static site ('' = site index). */
export const MARKETING_REDIRECTS: Record<string, string> = {
  '/start': '',
  '/vault': '',
  '/create-vault': 'create-vault.html',
  '/cloud-setup': 'cloud-setup.html',
  '/home-setup': 'home-setup.html',
};

export function publicSiteUrl(env: NodeJS.ProcessEnv = process.env) {
  const raw = String(env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[A-Za-z0-9.:\/_~-]+$/.test(raw) ? raw : DEFAULT_PUBLIC_SITE_URL;
}

/** Absolute redirect target for a marketing path, preserving the query string (e.g. ?ref=). */
export function marketingRedirectTarget(pathname: string, search = '', base = publicSiteUrl()) {
  const key = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (!Object.prototype.hasOwnProperty.call(MARKETING_REDIRECTS, key)) return null;
  const qs = search && search.startsWith('?') && search.length > 1 ? search : '';
  return `${base}/${MARKETING_REDIRECTS[key]}${qs}`;
}

/** Register 301s before the auth wall (they reveal nothing about the vault). */
export function registerMarketingRedirects(app: Express) {
  for (const p of Object.keys(MARKETING_REDIRECTS)) {
    app.get([p, `${p}/`], (req: Request, res: Response) => {
      const url = req.originalUrl || req.url;
      const i = url.indexOf('?');
      const target = marketingRedirectTarget(p, i >= 0 ? url.slice(i) : '');
      res.redirect(301, target!);
    });
  }
}

/** login.html ships with the default site URL; swap in PUBLIC_SITE_URL when configured. */
export function rewriteLoginHtml(html: string, base = publicSiteUrl()) {
  return html.split(`${DEFAULT_PUBLIC_SITE_URL}/`).join(`${base}/`);
}
