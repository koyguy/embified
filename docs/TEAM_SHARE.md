# Read-only team share links

Share a few WhatsApp groups from your vault with teammates, without giving them your inbox password.

- A share = `{id, label, groupIds[], created, revoked}` in `$DATA_DIR/shares.json`. Only `sha256(token)` is stored.
- The link is `http://<vault-ip>/s/<token>` (stable; redirects to the current https tunnel URL with the path kept)
  or `https://<tunnel>/s/<token>`. Opening it sets a separate `embified_share` cookie (HttpOnly, SameSite=Lax,
  Secure over https, 30 days) and opens a read-only inbox with only the shared groups.
- Enforced server-side (`server/share-routes.ts`, default-deny): a shared session can only `GET /api/share/me`,
  `/api/groups` (filtered), `/api/groups/<allowed>/messages`, `/api/events` (filtered) and `/media/<files of allowed
  groups>`. Everything else is 403/404: settings, provider switch, QR/link/reset, digest, history, funnel, any POST.
  Teammates reading never clear your unread badges. Your owner login keeps full access (and wins if a browser has both).
- Revoking is immediate for the link and every open shared session (checked on each request, live streams close).

## Commands (on the vault, as root)

```bash
sudo embified-share create --label "Embifi team" --group 120363...@g.us --group-name "Exact group name" --base http://<vault-ip>
sudo embified-share list
sudo embified-share revoke sh_xxxxxxxxxxxx
```

`create` prints the link once. No restart needed for any command.

Without SSH, use the **Team share admin** workflow (Actions → Run workflow). It never sees the token or group names:
pass `sha256(token)` and `sha256(exact group name)` values; `list` prints ids and counts only.

```bash
gh workflow run embified-share.yml -f action=revoke -f share_id=sh_xxxxxxxxxxxx
```

## Caveats

- Anyone holding the link can read those groups (including media) until you revoke it. Treat it like a password.
- The first hop to `http://<ip>/s/<token>` is plain http, so the token crosses the network unencrypted once before the
  redirect to https. Prefer sending the https form when the tunnel URL is current.
- The quick-tunnel https URL changes on restarts; the IP form always forwards to the current one.
