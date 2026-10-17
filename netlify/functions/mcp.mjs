// REGULEX public MCP server (Streamable HTTP, stateless, read-only).
// Exposes only information already published on regulex-legal.com: articles,
// newsletter issues and service pages. No client data, no writes, no messages.
const SERVER_INFO = { name: "com.regulex-legal/public-library", title: "REGULEX Public Library", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const NOTICE = "General public information from REGULEX Legal Consultancy, not legal advice. "
  + "Verify rules against current official sources; scope and fees are agreed with REGULEX directly.";
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

const TOOLS = [
  {
    name: "search_publications",
    title: "Search REGULEX publications",
    description: "Search REGULEX public articles and Regulex Legal Intelligence newsletter issues on UAE law. Returns titles, dates, summaries and links.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "Words to match in titles and summaries. Omit to list the latest." },
        type: { type: "string", enum: ["article", "newsletter"], description: "Optional filter by publication type." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_publication",
    title: "Read a REGULEX publication",
    description: "Return the full text (Markdown) of one REGULEX publication by its slug from search_publications.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", pattern: SLUG.source, description: "Publication slug, e.g. uae-corporate-tax-fta-private-clarifications." } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_services",
    title: "List REGULEX services",
    description: "List REGULEX legal service pages and public contact channels. Does not contact the firm or book anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const cache = new Map();
async function loadJson(origin, file) {
  const hit = cache.get(file);
  if (hit && Date.now() - hit.at < 300_000) return hit.data;
  const res = await fetch(`${origin}/api/v1/${file}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`data unavailable (${res.status})`);
  const data = await res.json();
  cache.set(file, { at: Date.now(), data });
  return data;
}

const result = data => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const toolError = message => ({ content: [{ type: "text", text: message }], isError: true });

async function callTool(origin, name, args = {}) {
  if (name === "search_publications") {
    const { items } = await loadJson(origin, "articles.json");
    const words = String(args.query || "").toLowerCase().slice(0, 200).split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(Number.parseInt(args.limit ?? 10, 10) || 10, 1), 20);
    const found = items
      .filter(i => !args.type || i.type === args.type)
      .filter(i => words.every(w => `${i.title} ${i.description}`.toLowerCase().includes(w)))
      .slice(0, limit);
    return result({ notice: NOTICE, count: found.length, items: found });
  }
  if (name === "get_publication") {
    const slug = String(args.slug || "");
    if (!SLUG.test(slug)) return toolError("Invalid slug. Use a slug returned by search_publications.");
    const { items } = await loadJson(origin, "articles.json");
    const meta = items.find(i => i.slug === slug);
    if (!meta) return toolError("Publication not found. Use search_publications to find a valid slug.");
    const res = await fetch(meta.url, { headers: { accept: "text/markdown" } });
    const text = res.ok && (res.headers.get("content-type") || "").includes("text/markdown") ? await res.text() : null;
    if (!text) return toolError("The publication text is temporarily unavailable. Open the URL instead: " + meta.url);
    return { content: [{ type: "text", text: `${NOTICE}\n\n${text}` }], structuredContent: { ...meta, notice: NOTICE } };
  }
  if (name === "list_services") {
    const data = await loadJson(origin, "services.json");
    return result(data);
  }
  return null;
}

const json = (body, status = 200, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", ...extra },
});
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg, origin) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid Request");
  const isNotification = !("id" in msg);
  const { id, method, params = {} } = msg;
  if (isNotification) return null; // e.g. notifications/initialized: nothing to return
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Read-only access to REGULEX public publications on UAE law and its service pages. " + NOTICE,
      } };
    }
    case "ping": return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      try {
        const out = await callTool(origin, params.name, params.arguments || {});
        return out ? { jsonrpc: "2.0", id, result: out } : rpcError(id, -32602, `Unknown tool: ${params.name}`);
      } catch (err) {
        return { jsonrpc: "2.0", id, result: toolError(`Temporary error: ${err.message}`) };
      }
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default async function mcp(request) {
  const origin = new URL(request.url).origin;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
    } });
  }
  // Stateless server: no SSE stream to open and no sessions to delete.
  if (request.method !== "POST") return json(rpcError(null, -32000, "Use POST (Streamable HTTP, stateless)."), 405, { allow: "POST, OPTIONS" });
  const raw = await request.text();
  if (raw.length > 64_000) return json(rpcError(null, -32600, "Request too large"), 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.slice(0, 20).map(m => handle(m, origin)))).filter(Boolean);
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
  }
  const reply = await handle(body, origin);
  return reply ? json(reply) : new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
}

export const config = { path: "/mcp" };
