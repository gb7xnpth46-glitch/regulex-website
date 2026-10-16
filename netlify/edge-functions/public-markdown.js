// Public HTML only. No external requests, credentials, or client documents.
const publicPaths = new Set([
  "/", "/about", "/people", "/corporate", "/international-arbitration",
  "/commercial-law", "/legal-drafting", "/structuring-private-clients",
  "/legal-services-subscription", "/news-publications", "/careers", "/privacy",
  "/news-publications/liquidation-in-uae", "/news-publications/medical-advice-uae",
  "/news-publications/newsletter-1", "/news-publications/regulation-of-mainland",
]);

function decodeEntities(text) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
    middot: "·", hellip: "…", copy: "©", bull: "•", euro: "€" };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? whole;
    const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  });
}

export function toMarkdown(html, sourceUrl) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i)?.[1];
  if (!body) return null;
  let text = body.replace(/<!--[\s\S]*?-->/g, "");
  // Remove active/non-content regions before extracting text, including GTM and forms.
  for (const tag of ["script", "style", "noscript", "svg", "iframe", "form", "nav", "footer"]) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, "gi"), "");
  }
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_all, attrs, label) => {
    const href = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
    const visible = decodeEntities(label.replace(/<[^>]*>/g, "")).trim().replace(/[\[\]<>]/g, "");
    if (!href || !visible) return visible;
    try {
      const url = new URL(decodeEntities(href), sourceUrl);
      if (!["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) return visible;
      return `[${visible}](${url.href.replace(/[()\s<>]/g, c => encodeURIComponent(c))})`;
    } catch { return visible; }
  });
  text = text.replace(/<h([1-6])\b[^>]*>/gi, (_all, level) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|header|article|main|ul|ol|blockquote|tr)\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text).replace(/[<>]/g, c => c === "<" ? "&lt;" : "&gt;")
    .replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text.includes("# ") || text.length < 100) return null;
  return `Source: ${sourceUrl}\n\n${text}\n`;
}

export function prefersMarkdown(accept) {
  const ranges = (accept || "").toLowerCase().split(",").map(value => {
    const [type, ...params] = value.trim().split(";");
    const quality = params.find(p => p.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { type, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
  });
  const quality = type => {
    for (const pattern of [type, "text/*", "*/*"]) {
      const exact = ranges.filter(r => r.type === pattern);
      if (exact.length) return Math.max(...exact.map(r => r.q));
    }
    return 0;
  };
  // A wildcard alone must never change the browser/default representation.
  return ranges.some(r => r.type === "text/markdown" && r.q > 0)
    && quality("text/markdown") >= quality("text/html");
}

export default async function publicMarkdown(request, context) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (!publicPaths.has(path) || !["GET", "HEAD"].includes(request.method)) return;
  const response = await context.next();
  const headers = new Headers(response.headers);
  const vary = new Set((headers.get("vary") || "").split(",").map(s => s.trim()).filter(Boolean));
  if (![...vary].some(v => v.toLowerCase() === "accept") && !vary.has("*")) vary.add("Accept");
  headers.set("Vary", [...vary].join(", "));
  // Keep HTML and Markdown distinct even through intermediaries that ignore Vary: Accept.
  // Browser cache policy and all original private/no-store checks remain authoritative.
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Netlify-CDN-Cache-Control", "no-store");
  const unchanged = (reason = "policy") => {
    // Temporary format-only diagnostic; never includes header values or user data.
    if (headers.get("content-type")?.includes("text/html")) {
      headers.set("Content-Type", `${headers.get("content-type")}; agent-mode=${reason}`);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  // Never transform authenticated, cookie-bearing, query-specific, private or gated responses.
  if (request.headers.get("authorization")?.trim() || request.headers.get("cookie")?.trim() || url.search
      || request.headers.has("range") || request.method === "HEAD"
      || !prefersMarkdown(request.headers.get("accept")) || response.status !== 200
      || !headers.get("content-type")?.toLowerCase().includes("text/html")
      || headers.has("set-cookie") || /private|no-store/i.test(headers.get("cache-control") || "")
      || /noindex/i.test(headers.get("x-robots-tag") || "")) {
    const reason = request.headers.get("authorization")?.trim() || request.headers.get("cookie")?.trim() ? "stateful"
      : url.search ? "query" : request.headers.has("range") ? "range"
      : request.method === "HEAD" ? "head" : !prefersMarkdown(request.headers.get("accept")) ? "html"
      : response.status !== 200 ? "status" : "origin-policy";
    return unchanged(reason);
  }
  const html = await response.clone().text();
  const noindex = [...html.matchAll(/<meta\b[^>]*>/gi)].some(([tag]) =>
    /\bname\s*=\s*["']robots["']/i.test(tag) && /\bcontent\s*=\s*["'][^"']*noindex/i.test(tag));
  if (html.length > 2_000_000 || noindex) return unchanged("document-policy");
  const markdown = toMarkdown(html, url.origin + path);
  if (!markdown) return unchanged("conversion");
  await response.body?.cancel();
  for (const key of ["content-length", "content-encoding", "content-range", "etag", "last-modified"]) headers.delete(key);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Netlify-CDN-Cache-Control", "no-store");
  headers.set("Content-Signal", "search=yes");
  return new Response(markdown, { status: 200, headers });
}

export const config = { path: [...publicPaths], onError: "bypass" };
