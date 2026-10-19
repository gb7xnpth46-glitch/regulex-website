// REGULEX authorization server for the inquiry API.
//
// Two ways for an agent to get a token that lets it send an enquiry for a person:
//  1. Standard OAuth 2.1: dynamic client registration + authorization code with PKCE.
//     The person sees a consent page here, enters the email we should reply to and approves.
//  2. auth.md agentic registration (anonymous + claim ceremony): the agent registers, gives
//     the person a 6-digit code, the person confirms it on regulex-legal.com.
// Either way a person has to approve on this site before any enquiry can be sent.
// The only thing a token allows is POST /api/v1/inquiries. Nothing here reads client data.
import {
  ISSUER, RESOURCE, SCOPE, ASSERTION_TTL, REGISTRATION_TTL, CODE_TTL,
  store, randomToken, randomDigits, sha256, now, iso, jwks, signJwt, verifyJwt,
  issueAccessToken, isRevoked, revoke, rateLimited, clientIp,
  json, oauthError, preflight, esc, EMAIL, readBody, page,
} from "../lib/oauth-core.mjs";

const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CONSENT_TEXT = "I agree that REGULEX may use these details to respond to my request, as described in the "
  + '<a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.';

// ---------------------------------------------------------------- helpers --
function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  } catch { return false; }
}
const cleanName = s => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
const redirectWith = (uri, params) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
};
const errorPage = (title, text) => page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);

async function issueIdentityAssertion(reg) {
  const iat = now();
  const exp = iat + ASSERTION_TTL;
  const assertion = await signJwt({
    iss: ISSUER, aud: ISSUER, sub: `reg:${reg.id}`, registration_id: reg.id, email: reg.email,
    client_name: reg.client_name, scope: SCOPE, jti: randomToken("ia_", 16), iat, exp,
  }, "identity-assertion+jwt");
  return { identity_assertion: assertion, assertion_expires: iso(exp) };
}

// --------------------------------------------------- dynamic registration --
async function register(req, context) {
  if (await rateLimited(`reg:${clientIp(req, context)}`, 20)) return oauthError("rate_limited", "Too many registrations; try later.", 429);
  const body = await readBody(req);
  if (!body) return oauthError("invalid_client_metadata", "Body must be JSON client metadata.");
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || uris.length > 5 || !uris.every(u => typeof u === "string" && validRedirect(u))) {
    return oauthError("invalid_redirect_uri", "Provide 1-5 redirect_uris using https, or http on a loopback address.");
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) with PKCE are supported.");
  }
  const client = {
    client_id: randomToken("cl_", 16),
    client_id_issued_at: now(),
    client_name: cleanName(body.client_name) || "AI agent",
    redirect_uris: uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  };
  await store().setJSON(`client/${client.client_id}`, client);
  return json(client, 201);
}

// ------------------------------------------------------- authorize (code) --
async function authorizeGet(url) {
  const q = Object.fromEntries(url.searchParams);
  const client = q.client_id && await store().get(`client/${q.client_id}`, { type: "json" });
  if (!client) return errorPage("Unknown application", "This authorization link does not come from a registered application.");
  const redirect_uri = q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!client.redirect_uris.includes(redirect_uri)) return errorPage("Invalid link", "The redirect address does not match the application's registration.");

  const fail = (error, description) => redirectWith(redirect_uri, { error, error_description: description, state: q.state, iss: ISSUER });
  if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge || "")) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (q.scope && !q.scope.split(" ").every(s => s === SCOPE)) return fail("invalid_scope", `The only scope is ${SCOPE}.`);
  if (q.resource && q.resource.replace(/\/$/, "") !== RESOURCE) return fail("invalid_target", `The resource is ${RESOURCE}.`);

  const request = await signJwt({
    iss: ISSUER, client_id: client.client_id, redirect_uri, state: q.state || null,
    code_challenge: q.code_challenge, exp: now() + CODE_TTL,
  }, "authz-request+jwt");
  const target = new URL(redirect_uri).origin;
  return page("Allow an AI agent to contact REGULEX", `
<h1>Allow an AI agent to contact REGULEX for you?</h1>
<p>The application <strong>${esc(client.client_name)}</strong> (name supplied by the application, not verified by REGULEX) asks to send enquiries to REGULEX Legal Consultancy on your behalf.</p>
<p>It will only be able to send enquiries. It cannot read anything from REGULEX. Access ends after one hour.</p>
<form method="post" action="/oauth2/authorize">
<input type="hidden" name="request" value="${esc(request)}">
<label for="email">Email REGULEX should reply to</label>
<input id="email" type="email" name="email" required autocomplete="email">
<p style="margin-top:14px"><label class="chk"><input type="checkbox" name="consent" value="yes" required> <span>${CONSENT_TEXT}</span></label></p>
<div class="row"><button class="no" name="decision" value="deny" formnovalidate>Deny</button><button class="ok" name="decision" value="allow">Allow</button></div>
</form>`, { formAction: `'self' ${target}` });
}

async function authorizePost(req) {
  const body = await readBody(req);
  const r = body && await verifyJwt(body.request, "authz-request+jwt");
  if (!r) return errorPage("Request expired", "Please start again from the application.");
  if (body.decision !== "allow") return redirectWith(r.redirect_uri, { error: "access_denied", state: r.state, iss: ISSUER });
  const email = String(body.email || "").trim();
  if (!EMAIL.test(email) || body.consent !== "yes") return errorPage("Missing details", "Enter a valid email and accept the Privacy Policy, then try again from the application.");
  const code = randomToken("ac_", 24);
  await store().setJSON(`code/${await sha256(code)}`, {
    client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, email, exp: now() + 300,
  });
  return redirectWith(r.redirect_uri, { code, state: r.state, iss: ISSUER });
}

// ------------------------------------------------------------------ token --
async function token(req) {
  const body = await readBody(req);
  if (!body) return oauthError("invalid_request", "Send application/x-www-form-urlencoded parameters.");
  const s = store();

  if (body.grant_type === "authorization_code") {
    const key = `code/${await sha256(String(body.code || ""))}`;
    const rec = await s.get(key, { type: "json" });
    if (rec) await s.delete(key); // single use
    if (!rec || rec.exp <= now()) return oauthError("invalid_grant", "Authorization code is invalid or expired.");
    if (rec.client_id !== body.client_id || (body.redirect_uri && body.redirect_uri !== rec.redirect_uri)) {
      return oauthError("invalid_grant", "client_id or redirect_uri does not match the authorization request.");
    }
    if (!body.code_verifier || await sha256(body.code_verifier) !== rec.code_challenge) return oauthError("invalid_grant", "PKCE verification failed.");
    const client = await s.get(`client/${rec.client_id}`, { type: "json" });
    return json(await issueAccessToken({
      sub: `email:${(await sha256(rec.email.toLowerCase())).slice(0, 22)}`, email: rec.email,
      client_id: rec.client_id, client_name: client?.client_name,
    }));
  }

  if (body.grant_type === JWT_BEARER) {
    const a = await verifyJwt(body.assertion, "identity-assertion+jwt");
    if (!a || await isRevoked(a.jti)) return oauthError("invalid_grant", "identity_assertion is invalid, expired or revoked. Restart at registration.");
    const reg = await s.get(`reg/${a.registration_id}`, { type: "json" });
    if (!reg || reg.revoked || !reg.claimed) return oauthError("invalid_grant", "The registration is no longer active. Restart at registration.");
    if (body.resource && body.resource.replace(/\/$/, "") !== RESOURCE) return oauthError("invalid_target", `The resource is ${RESOURCE}.`);
    return json(await issueAccessToken({ sub: a.sub, email: reg.email, client_name: reg.client_name, registration_id: reg.id }));
  }

  if (body.grant_type === CLAIM_GRANT) {
    const regId = await s.get(`claimtok/${await sha256(String(body.claim_token || ""))}`, { type: "json" });
    const reg = regId && await s.get(`reg/${regId.id}`, { type: "json" });
    if (!reg || reg.revoked) return oauthError("invalid_grant", "claim_token is not recognised.");
    if (reg.claimed) {
      if (reg.delivered) return oauthError("invalid_grant", "Tokens for this claim were already issued; use the identity_assertion.");
      reg.delivered = true;
      await s.setJSON(`reg/${reg.id}`, reg);
      return json({ ...await issueAccessToken({ sub: `reg:${reg.id}`, email: reg.email, client_name: reg.client_name, registration_id: reg.id }),
        ...await issueIdentityAssertion(reg) });
    }
    if (reg.expires <= now()) return oauthError("expired_token", "The registration expired. Restart at registration.");
    const attemptLive = reg.attempt_expires && reg.attempt_expires > now();
    if (!attemptLive) return oauthError("expired_token", "No active claim attempt. Call the claim endpoint again for a new user_code.");
    if (reg.last_poll && now() - reg.last_poll < 4) {
      reg.last_poll = now(); await s.setJSON(`reg/${reg.id}`, reg);
      return oauthError("slow_down", "Polling too fast; wait at least 5 seconds.");
    }
    reg.last_poll = now(); await s.setJSON(`reg/${reg.id}`, reg);
    return oauthError("authorization_pending", "The person has not confirmed the code yet.");
  }

  return oauthError("unsupported_grant_type", `Supported: authorization_code, ${JWT_BEARER}, ${CLAIM_GRANT}.`);
}

async function revokeEndpoint(req) {
  const body = await readBody(req);
  const t = String(body?.token || "");
  const at = await verifyJwt(t, "at+jwt");
  if (at) await revoke(at.jti, at.exp);
  const ia = !at && await verifyJwt(t, "identity-assertion+jwt");
  if (ia) {
    await revoke(ia.jti, ia.exp);
    const s = store();
    const reg = await s.get(`reg/${ia.registration_id}`, { type: "json" });
    if (reg) await s.setJSON(`reg/${reg.id}`, { ...reg, revoked: true });
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } }); // RFC 7009: always 200
}

// --------------------------------------------- auth.md agentic registration --
async function agentIdentity(req, context) {
  if (await rateLimited(`ident:${clientIp(req, context)}`, 20)) return json({ error: "rate_limited" }, 429);
  const body = await readBody(req);
  if (!body) return json({ error: "invalid_request", error_description: "Send a JSON body." }, 400);
  if (body.type === "service_auth") return json({ error: "service_auth_not_enabled", error_description: "Use anonymous registration with the claim ceremony." }, 400);
  if (body.type === "identity_assertion") return json({ error: "issuer_not_enabled", error_description: "No identity providers are trusted yet. Use anonymous registration." }, 400);
  if (body.type !== "anonymous") return json({ error: "invalid_request", error_description: "type must be anonymous." }, 400);

  const reg = { id: randomToken("reg_", 12), created: now(), expires: now() + REGISTRATION_TTL,
    client_name: cleanName(body.client_name || body.agent_name) || "AI agent", claimed: false };
  const claimToken = randomToken("clm_", 24);
  const s = store();
  await s.setJSON(`reg/${reg.id}`, reg);
  await s.setJSON(`claimtok/${await sha256(claimToken)}`, { id: reg.id });
  return json({
    registration_id: reg.id,
    registration_type: "anonymous",
    pre_claim_scopes: [],
    claim_url: `${ISSUER}/agent/identity/claim`,
    claim_token: claimToken,
    claim_token_expires: iso(reg.expires),
    post_claim_scopes: [SCOPE],
    note: "No access before the claim ceremony: a person must confirm the code on regulex-legal.com.",
  });
}

async function agentClaim(req, context) {
  if (await rateLimited(`claim:${clientIp(req, context)}`, 30)) return json({ error: "rate_limited" }, 429);
  const body = await readBody(req);
  const s = store();
  const regId = body && await s.get(`claimtok/${await sha256(String(body.claim_token || ""))}`, { type: "json" });
  const reg = regId && await s.get(`reg/${regId.id}`, { type: "json" });
  if (!reg || reg.revoked) return json({ error: "invalid_claim_token" }, 400);
  if (reg.claimed) return json({ error: "claimed_or_in_flight" }, 409);
  if (reg.expires <= now()) return json({ error: "claim_expired" }, 410);
  const email = String(body.email || "").trim();
  if (!EMAIL.test(email)) return json({ error: "invalid_request", error_description: "email of the person you act for is required." }, 400);

  const attemptToken = randomToken("cat_", 24);
  const userCode = randomDigits(6);
  const exp = now() + CODE_TTL;
  await s.setJSON(`attempt/${await sha256(attemptToken)}`, { reg_id: reg.id, email, code: await sha256(userCode), exp, tries: 0 });
  await s.setJSON(`reg/${reg.id}`, { ...reg, attempt_expires: exp });
  return json({
    registration_id: reg.id,
    claim_attempt_id: randomToken("cla_", 8),
    status: "initiated",
    expires_at: iso(exp),
    claim_attempt: {
      user_code: userCode,
      expires_in: CODE_TTL,
      verification_uri: `${ISSUER}/agent/claim?claim_attempt_token=${encodeURIComponent(attemptToken)}`,
      interval: 5,
    },
  });
}

// The page the person opens to confirm the agent's code.
async function claimPage(req, url) {
  const s = store();
  const isPost = req.method === "POST";
  const body = isPost ? await readBody(req) : null;
  const attemptToken = String((isPost ? body?.claim_attempt_token : url.searchParams.get("claim_attempt_token")) || "");
  const key = `attempt/${await sha256(attemptToken)}`;
  const attempt = attemptToken && await s.get(key, { type: "json" });
  const reg = attempt && await s.get(`reg/${attempt.reg_id}`, { type: "json" });
  if (!attempt || !reg || reg.revoked || attempt.exp <= now()) return errorPage("Link expired", "Ask your AI agent for a new link and code.");
  if (reg.claimed) return errorPage("Already confirmed", "This agent is already authorized.");

  let error = "";
  if (isPost) {
    const code = String(body.user_code || "").replace(/\D/g, "");
    if (attempt.tries >= 5) return errorPage("Too many attempts", "Ask your AI agent for a new code.");
    if (body.consent !== "yes") error = "Please accept the Privacy Policy.";
    else if (await sha256(code) !== attempt.code) {
      error = "That code is not correct.";
      await s.setJSON(key, { ...attempt, tries: attempt.tries + 1 });
    } else {
      await s.setJSON(`reg/${reg.id}`, { ...reg, claimed: true, email: attempt.email, claimed_at: now(), consent: "privacy-policy" });
      await s.delete(key);
      return page("Agent authorized", `<h1>Done</h1><p><strong>${esc(reg.client_name)}</strong> can now send enquiries to REGULEX on your behalf. We will reply to <strong>${esc(attempt.email)}</strong>.</p><p>You can close this page and return to your agent.</p>`);
    }
  }
  return page("Confirm your AI agent", `
<h1>Confirm your AI agent</h1>
<p>An AI agent calling itself <strong>${esc(reg.client_name)}</strong> asks to send enquiries to REGULEX Legal Consultancy on behalf of <strong>${esc(attempt.email)}</strong>.</p>
<p>Only continue if you asked an agent to contact REGULEX and this is your email. The agent will only be able to send enquiries; it cannot read anything from REGULEX.</p>
<form method="post" action="/agent/claim">
<input type="hidden" name="claim_attempt_token" value="${esc(attemptToken)}">
<label for="code">6-digit code from your agent</label>
<input id="code" class="code" type="text" name="user_code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required>
<p style="margin-top:14px"><label class="chk"><input type="checkbox" name="consent" value="yes" required> <span>${CONSENT_TEXT}</span></label></p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<div class="row"><button class="ok" type="submit">Confirm</button></div>
</form>`);
}

// ----------------------------------------------------------------- router --
export default async function oauth(req, context) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  if (req.method === "OPTIONS" && path !== "/oauth2/authorize" && path !== "/agent/claim") return preflight();
  try {
    if (path === "/.well-known/jwks.json" && req.method === "GET") {
      return json(await jwks(), 200, { "cache-control": "public, max-age=300" });
    }
    if (path === "/oauth2/register" && req.method === "POST") return register(req, context);
    if (path === "/oauth2/authorize" && req.method === "GET") return authorizeGet(url);
    if (path === "/oauth2/authorize" && req.method === "POST") return authorizePost(req);
    if (path === "/oauth2/token" && req.method === "POST") return token(req);
    if (path === "/oauth2/revoke" && req.method === "POST") return revokeEndpoint(req);
    if (path === "/agent/identity" && req.method === "POST") return agentIdentity(req, context);
    if (path === "/agent/identity/claim" && req.method === "POST") return agentClaim(req, context);
    if (path === "/agent/claim" && (req.method === "GET" || req.method === "POST")) return claimPage(req, url);
    return json({ error: "not_found", documentation: `${ISSUER}/auth.md` }, req.method === "GET" || req.method === "POST" ? 404 : 405);
  } catch (err) {
    console.error("oauth error", err);
    return json({ error: "server_error", error_description: "Temporary error; retry later." }, 500);
  }
}

export const config = {
  path: ["/.well-known/jwks.json", "/oauth2/*", "/agent/identity", "/agent/identity/claim", "/agent/claim"],
};
