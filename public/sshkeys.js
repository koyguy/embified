/*
 * Browser-only SSH keypair generation for the /start quest (WebCrypto).
 * Nothing is uploaded: the private key is offered as a download and never leaves the device.
 * Ed25519 when the browser supports it, otherwise RSA-3072.
 */
(function (root) {
  const enc = new TextEncoder();
  const subtle = (root.crypto && root.crypto.subtle) || null;

  function concat(parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function u32(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }
  function sshString(bytes) {
    if (typeof bytes === 'string') bytes = enc.encode(bytes);
    return concat([u32(bytes.length), bytes]);
  }
  function mpint(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    bytes = bytes.slice(i);
    if (bytes[0] & 0x80) bytes = concat([new Uint8Array([0]), bytes]);
    return sshString(bytes);
  }
  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64urlToBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function wrap(s, n) {
    const lines = [];
    for (let i = 0; i < s.length; i += n) lines.push(s.slice(i, i + n));
    return lines.join('\n');
  }
  function randomU32() {
    const a = new Uint32Array(1);
    root.crypto.getRandomValues(a);
    return a[0];
  }

  async function supportsEd25519() {
    if (!subtle) return false;
    try {
      await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      return true;
    } catch {
      return false;
    }
  }

  async function ed25519Material(useNacl) {
    if (!useNacl) {
      const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
      const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
      return { pub, seed: pkcs8.slice(pkcs8.length - 32) }; // PKCS#8 Ed25519: header + OCTET STRING(32-byte seed)
    }
    // Insecure context (plain http on an IP) has no crypto.subtle: use tweetnacl + getRandomValues.
    const seed = new Uint8Array(32);
    root.crypto.getRandomValues(seed);
    const kp = root.nacl.sign.keyPair.fromSeed(seed);
    return { pub: kp.publicKey, seed };
  }

  async function genEd25519(comment, useNacl) {
    const { pub, seed } = await ed25519Material(useNacl);
    const type = 'ssh-ed25519';
    const pubBlob = concat([sshString(type), sshString(pub)]);
    const check = u32(randomU32());
    let priv = concat([check, check, sshString(type), sshString(pub), sshString(concat([seed, pub])), sshString(comment)]);
    const pad = [];
    for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
    priv = concat([priv, new Uint8Array(pad)]);
    const body = concat([
      enc.encode('openssh-key-v1\0'),
      sshString('none'),
      sshString('none'),
      sshString(new Uint8Array(0)),
      u32(1),
      sshString(pubBlob),
      sshString(priv),
    ]);
    return {
      type: 'ed25519',
      publicKey: type + ' ' + b64(pubBlob) + ' ' + comment,
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n' + wrap(b64(body), 70) + '\n-----END OPENSSH PRIVATE KEY-----\n',
      filename: 'embified_ed25519',
    };
  }

  async function genRsa(comment) {
    const kp = await subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    const jwk = await subtle.exportKey('jwk', kp.publicKey);
    const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
    const pubBlob = concat([sshString('ssh-rsa'), mpint(b64urlToBytes(jwk.e)), mpint(b64urlToBytes(jwk.n))]);
    return {
      type: 'rsa',
      publicKey: 'ssh-rsa ' + b64(pubBlob) + ' ' + comment,
      privateKey: '-----BEGIN PRIVATE KEY-----\n' + wrap(b64(pkcs8), 64) + '\n-----END PRIVATE KEY-----\n',
      filename: 'embified_rsa',
    };
  }

  async function generate(opts) {
    opts = opts || {};
    const comment = (opts.comment || 'embified-vault').replace(/\s+/g, '-');
    const hasNacl = !!(root.nacl && root.nacl.sign && root.crypto && root.crypto.getRandomValues);
    if (opts.type === 'rsa' && subtle) return genRsa(comment);
    if (subtle && (await supportsEd25519())) return genEd25519(comment, false);
    if (hasNacl) return genEd25519(comment, true);
    if (subtle) return genRsa(comment);
    throw new Error('This browser cannot generate keys here. Run ssh-keygen in a terminal and paste the public key instead.');
  }

  root.EmbifiedSSH = { generate, supportsEd25519 };
})(typeof window !== 'undefined' ? window : globalThis);
