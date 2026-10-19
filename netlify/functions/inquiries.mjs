// Protected inquiry API: an authorized AI agent sends an enquiry for the person who approved it.
// The enquiry goes into the same Netlify Forms inbox as the website contact form; the reply
// email is always the one the person confirmed on regulex-legal.com, never one the agent supplies.
import {
  ISSUER, RESOURCE, PRM_URL, SCOPE, verifyJwt, isRevoked, store, rateLimited,
  json, preflight,
} from "../lib/oauth-core.mjs";

const SERVICES = ["Corporate Structuring", "International Arbitration", "Commercial Contracts",
  "Legal Drafting", "Private Clients", "Ongoing Advisory", "Other"];
const challenge = (error, description) => ({
  "www-authenticate": `Bearer resource_metadata="${PRM_URL}", scope="${SCOPE}"`
    + (error ? `, error="${error}", error_description="${description}"` : ""),
});
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);

export default async function inquiries(req) {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed", documentation: `${ISSUER}/auth.md` }, 405, { allow: "POST, OPTIONS" });

  const auth = req.headers.get("authorization") || "";
  const tokenValue = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!tokenValue) {
    return json({ error: "unauthorized", error_description: "An access token is required.", documentation: `${ISSUER}/auth.md` },
      401, challenge());
  }
  const t = await verifyJwt(tokenValue, "at+jwt");
  if (!t || t.aud !== RESOURCE || await isRevoked(t.jti)) {
    return json({ error: "invalid_token" }, 401, challenge("invalid_token", "The access token is invalid, expired or revoked"));
  }
  if (!String(t.scope).split(" ").includes(SCOPE)) {
    return json({ error: "insufficient_scope" }, 403, challenge("insufficient_scope", `Requires ${SCOPE}`));
  }
  if (await rateLimited(`inq:${t.sub}`, 5)) return json({ error: "rate_limited", error_description: "At most 5 enquiries per hour." }, 429);

  let body;
  try { body = JSON.parse(await req.text() || "{}"); } catch { return json({ error: "invalid_request", error_description: "Send JSON." }, 400); }
  const name = clip(body.name, 120);
  const message = clip(body.message, 5000);
  if (!name || !message) return json({ error: "invalid_request", error_description: "name and message are required." }, 400);
  const service = SERVICES.includes(body.service) ? body.service : "Other";

  const via = `[Sent by AI agent "${clip(t.client_name, 80) || "AI agent"}" through the REGULEX inquiry API. `
    + `Authorized on regulex-legal.com for ${t.email}.]`;
  const form = new URLSearchParams({
    "form-name": "contact", "bot-field": "", name, email: t.email, phone: clip(body.phone, 40), service,
    message: `${via}\n\n${message}`, consent: "yes",
  });
  const res = await fetch(`${new URL(req.url).origin}/`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
  });
  if (!res.ok) return json({ error: "temporarily_unavailable", error_description: "Could not deliver the enquiry; retry later or email info@regulex-legal.com." }, 502);

  const id = `inq_${crypto.randomUUID()}`;
  await store().setJSON(`inquiry/${id}`, { at: new Date().toISOString(), sub: t.sub }); // no personal data kept here
  return json({
    id, status: "received", reply_to: t.email,
    message: "Thank you. The request has been sent and REGULEX will reply by email or WhatsApp.",
  }, 201);
}

export const config = { path: "/api/v1/inquiries" };
