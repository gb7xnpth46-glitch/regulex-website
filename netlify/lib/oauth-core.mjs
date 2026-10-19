// Shared pieces of the REGULEX authorization server and the inquiry API.
// Tokens are ES256 JWTs. The signing key is generated on first use and kept in a
// private Netlify Blobs store, so no person ever sees or handles it.
import { getStore } from "@netlify/blobs";

export const ISSUER = "https://regulex-legal.com";
export const RESOURCE = "https://regulex-legal.com";
export const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource`;
export const SCOPE = "inquiries:write";
export const ACCESS_TTL = 3600;              // access_token lifetime, seconds
export const ASSERTION_TTL = 30 * 24 * 3600; // service-signed identity_assertion
export const REGISTRATION_TTL = 24 * 3600;   // unclaimed anonymous registration
export const CODE_TTL = 600;                 // user_code and authorization code

const enc = new TextEncoder();
export const store = () => getStore({ name: "regulex-oauth", consistency: "strong" });

export const b64url = bytes => Buffer.from(bytes).toString("base64url");
export const randomToken = (prefix, size = 32) => `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(size)))}`;
export const randomDigits = n => Array.from(crypto.getRandomValues(new Uint32Array(n)), v => v % 10).join("");
export async function sha256(text) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}
export const now = () => Math.floor(Date.now() / 1000);
export const iso = seconds => new Date(seconds * 1000).toISOString();

// ---- signing key -----------------------------------------------------------
let keyCache;
async function signingKey() {
  if (keyCache) return keyCache;
  const s = store();
  let rec = await s.get("keys/signing", { type: "json" });
  if (!rec) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const kid = (await sha256(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y }))).slice(0, 16);
    await s.setJSON("keys/signing", { kid, priv, pub }, { onlyIfNew: true });
    rec = await s.get("keys/signing", { type: "json" }); // another instance may have won the race
  }
  keyCache = {
    kid: rec.kid,
    pub: { ...rec.pub, kid: rec.kid, alg: "ES256", use: "sig", key_ops: undefined, ext: undefined },
    privateKey: await crypto.subtle.importKey("jwk", rec.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    publicKey: await crypto.subtle.importKey("jwk", rec.pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
  };
  return keyCache;
}
export async function jwks() {
  const { pub } = await signingKey();
  const { kty, crv, x, y, kid, alg, use } = pub;
  return { keys: [{ kty, crv, x, y, kid, alg, use }] };
}

// ---- JWT -------------------------------------------------------------------
export async function signJwt(payload, typ) {
  const k = await signingKey();
  const head = b64url(enc.encode(JSON.stringify({ alg: "ES256", typ, kid: k.kid })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
// Returns the payload when the JWT is ours, of the expected type and unexpired; otherwise null.
export async function verifyJwt(token, typ) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (head.alg !== "ES256" || head.typ !== typ) return null;
    const k = await signingKey();
    if (head.kid !== k.kid) return null;
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.publicKey,
      Buffer.from(parts[2], "base64url"), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (p.iss !== ISSUER || typeof p.exp !== "number" || p.exp <= now()) return null;
    return p;
  } catch {
    return null;
  }
}
export const isRevoked = async jti => Boolean(jti && await store().get(`revoked/${jti}`));
export const revoke = (jti, exp) => store().setJSON(`revoked/${jti}`, { exp });

export async function issueAccessToken({ sub, email, client_id, client_name, registration_id }) {
  const iat = now();
  const token = await signJwt({
    iss: ISSUER, aud: RESOURCE, sub, email, scope: SCOPE, client_id, client_name, registration_id,
    jti: randomToken("at_", 16), iat, exp: iat + ACCESS_TTL,
  }, "at+jwt");
  return { access_token: token, token_type: "Bearer", expires_in: ACCESS_TTL, scope: SCOPE };
}

// ---- rate limiting (approximate; per hour bucket) ---------------------------
export async function rateLimited(bucket, limit) {
  const s = store();
  const key = `rl/${bucket}/${Math.floor(Date.now() / 3600_000)}`;
  const n = ((await s.get(key, { type: "json" }))?.n || 0) + 1;
  await s.setJSON(key, { n });
  return n > limit;
}
export const clientIp = (req, context) => context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";

// ---- responses -------------------------------------------------------------
const base = { "cache-control": "no-store", "access-control-allow-origin": "*" };
export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...base, ...extra } });
export const oauthError = (error, description, status = 400, extra = {}) =>
  json({ error, error_description: description }, status, extra);
export const preflight = () => new Response(null, { status: 204, headers: {
  ...base,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "600",
} });
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;

export async function readBody(req) {
  const raw = await req.text();
  if (raw.length > 16_000) return null;
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) { try { return JSON.parse(raw || "{}"); } catch { return null; } }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Small, self-contained page for the human consent screens (no external assets).
export function page(title, body, { formAction = "'self'" } = {}) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | REGULEX</title>
<style>:root{--g:#0c5a3c;--t:#1a2a22;--t2:#4a5b52;--b:#e2e6e3}*{box-sizing:border-box}body{margin:0;background:#f4f7f5;color:var(--t);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:48px auto;padding:0 16px}.card{background:#fff;border:1px solid var(--b);border-radius:20px;padding:28px}
h1{font:600 1.5rem/1.3 Georgia,serif;margin:0 0 12px}p{margin:0 0 14px;color:var(--t2)}strong{color:var(--t)}
label{display:block;font-size:.9rem;margin:14px 0 6px}input[type=email],input[type=text]{width:100%;padding:12px 14px;border:1px solid var(--b);border-radius:12px;font:inherit}
.code{letter-spacing:.4em;font-size:1.3rem;text-align:center}.chk{display:flex;gap:10px;align-items:flex-start;font-size:.88rem;color:var(--t2)}.chk input{margin-top:4px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:13px;border-radius:999px;border:1px solid var(--g);font:600 .9rem system-ui,sans-serif;cursor:pointer}
.ok{background:var(--g);color:#fff}.no{background:#fff;color:var(--g)}.err{color:#a3261b}a{color:var(--g)}.brand{font:600 1.1rem Georgia,serif;letter-spacing:.08em;color:var(--g);margin-bottom:18px;display:block;text-decoration:none}</style>
</head><body><main><a class="brand" href="/">REGULEX</a><div class="card">${body}</div></main></body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
    },
  });
}
