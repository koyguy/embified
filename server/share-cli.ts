/**
 * Owner-only CLI for read-only team share links. Run on the vault host as the service user, e.g.
 *   sudo -u <svc-user> env DATA_DIR=/data/store npm run -s share -- create --label "Embifi team" \
 *        --group 1203...@g.us --group-name "Exact group name"
 *   ... npm run -s share -- list
 *   ... npm run -s share -- revoke sh_xxxxxxxxxxxx
 * The token is printed once on create and never stored (shares.json keeps only its sha256).
 * Revoking takes effect on the next request, including already-open shared sessions; no restart needed.
 */
import crypto from 'crypto';
import * as store from './store.ts';
import { createShare, loadShares, revokeShare, sharesFile } from './shares.ts';
import { publicHttpsUrl } from './tunnel.ts';

function usage(code = 1): never {
  console.error(`usage:
  share create --label <text> (--group <id> | --group-name <exact name> | --group-name-sha256 <hex>)... [--token-hash <sha256 hex>] [--base http://<ip>]
  share list
  share revoke <share id>`);
  process.exit(code);
}

function parse(argv: string[]) {
  const out: { _: string[]; label?: string; groups: string[]; names: string[]; nameHashes: string[]; tokenHash?: string; base?: string; json?: boolean } = {
    _: [],
    groups: [],
    names: [],
    nameHashes: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v;
    };
    if (a === '--label') out.label = val();
    else if (a === '--group') out.groups.push(val());
    else if (a === '--group-name') out.names.push(val());
    else if (a === '--group-name-sha256') out.nameHashes.push(val().toLowerCase());
    else if (a === '--token-hash') out.tokenHash = val();
    else if (a === '--base') out.base = val().replace(/\/+$/, '');
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') usage(0);
    else out._.push(a);
  }
  return out;
}

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function resolveGroups(o: ReturnType<typeof parse>) {
  const all = store.listGroups();
  const ids = [...o.groups];
  for (const g of o.groups) {
    if (!all.some((x) => x.id === g)) throw new Error(`group ${g} is not in this vault`);
  }
  const byName = (pred: (n: string) => boolean, what: string) => {
    const hits = all.filter((g) => pred(g.name));
    if (hits.length !== 1) throw new Error(`${what}: expected exactly 1 group, found ${hits.length}`);
    ids.push(hits[0].id);
  };
  for (const n of o.names) byName((x) => x === n, `--group-name "${n}"`);
  for (const h of o.nameHashes) byName((x) => sha(x) === h, `--group-name-sha256 ${h.slice(0, 8)}…`);
  return [...new Set(ids)];
}

function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'create') {
    if (!o.label) usage();
    const groupIds = resolveGroups(o);
    const { share, token } = createShare({ label: o.label, groupIds, tokenHash: o.tokenHash });
    const names = new Map(store.listGroups().map((g) => [g.id, g.name]));
    if (o.json) {
      console.log(JSON.stringify({ id: share.id, label: share.label, groupIds: share.groupIds, token }));
      return;
    }
    console.log(`Created share ${share.id} "${share.label}" for ${share.groupIds.length} group(s):`);
    for (const g of share.groupIds) console.log(`  - ${names.get(g) || '?'} (${g})`);
    if (token) {
      const p = `/s/${token}`;
      console.log('\nShare link (shown once; anyone with it can read these groups):');
      if (o.base) console.log(`  stable: ${o.base}${p}`);
      const https = publicHttpsUrl();
      if (https) console.log(`  https:  ${https}${p}`);
      if (!o.base && !https) console.log(`  path:   ${p}`);
    } else {
      console.log('\nToken supplied by hash; use the link you generated it for.');
    }
    console.log(`\nRevoke: npm run -s share -- revoke ${share.id}`);
    return;
  }
  if (cmd === 'list') {
    const names = new Map(store.listGroups().map((g) => [g.id, g.name]));
    const shares = loadShares();
    if (o.json) {
      console.log(JSON.stringify(shares.map(({ tokenHash: _t, ...s }) => s)));
      return;
    }
    if (!shares.length) console.log(`No shares (${sharesFile()}).`);
    for (const s of shares) {
      console.log(`${s.id}  ${s.revoked ? `REVOKED ${s.revoked}` : 'active'}  "${s.label}"  created ${s.created}`);
      for (const g of s.groupIds) console.log(`    - ${names.get(g) || '?'} (${g})`);
    }
    return;
  }
  if (cmd === 'revoke') {
    const id = o._[1];
    if (!id) usage();
    const s = revokeShare(id);
    console.log(`Revoked ${s.id} "${s.label}" at ${s.revoked}. Its link and any open shared sessions stop working now.`);
    return;
  }
  usage();
}

try {
  main();
} catch (e: any) {
  console.error(`share: ${e?.message || e}`);
  process.exit(1);
}
