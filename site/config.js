/*
 * Embified public site config. Plain JS, no build step — edit and push to main.
 * See docs/PUBLIC_SITE.md.
 */
window.EMBIFIED_SITE = {
  // Canonical URL of this static site, no trailing slash. Used for invite/referral links.
  // After adding a custom domain (site/CNAME), change this to e.g. 'https://embified.example'.
  SITE_URL: 'https://koyguy.github.io/embified',

  // Optional anonymous funnel analytics. Empty string = disabled (the quest makes no network calls).
  // To enable, set an HTTPS endpoint that accepts cross-origin POSTs of JSON
  // {event, cid, level, ref} and answers the CORS preflight for this site's origin.
  ANALYTICS_URL: '',
};
