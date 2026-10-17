// Builds the public read-only API data from the site's own HTML pages.
// Runs on every Netlify deploy (see netlify.toml), so newly published articles
// and newsletter issues appear in /api/v1/articles.json automatically.
// Public pages only: no client data, credentials or drafts (_preview-*) are read.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://regulex-legal.com";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "api", "v1");

const SERVICE_PAGES = [
  "legal-services-subscription", "structuring-private-clients", "corporate",
  "commercial-law", "legal-drafting", "international-arbitration",
];

const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|quot|apos|lt|gt|nbsp|mdash|ndash|rsquo|lsquo|rdquo|ldquo);/g, (_, e) => ({
    amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", mdash: "—", ndash: "–",
    rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" })[e]);
const text = s => decode((s || "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

function readPage(file) {
  const html = fs.readFileSync(file, "utf8");
  const title = text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1])
    || text(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]).replace(/\s*\|.*$/, "");
  const description = text(html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1]);
  const datePublished = html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/)?.[1] || null;
  return { title, description, datePublished };
}

function buildArticles() {
  const dir = path.join(root, "news-publications");
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    const slug = name.replace(/\.html$/, "");
    if (!name.endsWith(".html") || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue; // skip drafts
    try {
      const page = readPage(path.join(dir, name));
      if (!page.title) continue;
      items.push({
        slug,
        title: page.title,
        description: page.description,
        datePublished: page.datePublished,
        type: /^(regulex-legal-intelligence-|newsletter-)/.test(slug) ? "newsletter" : "article",
        url: `${ORIGIN}/news-publications/${slug}`,
      });
    } catch (err) {
      console.warn(`skip ${name}: ${err.message}`);
    }
  }
  return items.sort((a, b) => (b.datePublished || "").localeCompare(a.datePublished || ""));
}

function buildServices() {
  return SERVICE_PAGES.flatMap(slug => {
    const file = path.join(root, `${slug}.html`);
    if (!fs.existsSync(file)) return [];
    const { title, description } = readPage(file);
    return [{ slug, title, description, url: `${ORIGIN}/${slug}` }];
  });
}

const notice = "General public information from REGULEX Legal Consultancy. Not legal advice; "
  + "verify rules against current official sources. Scope and fees are agreed with REGULEX directly.";

try {
  fs.mkdirSync(outDir, { recursive: true });
  const articles = buildArticles();
  const services = buildServices();
  const write = (file, data) => fs.writeFileSync(path.join(outDir, file), JSON.stringify(data, null, 2) + "\n");
  write("articles.json", { notice, count: articles.length, items: articles });
  write("services.json", {
    notice,
    contact: {
      whatsapp: "https://wa.me/971527229941",
      email: "info@regulex-legal.com",
      note: "Contact is made by the user. Agents must not send messages on a user's behalf without their consent.",
    },
    items: services,
  });
  console.log(`public index: ${articles.length} articles, ${services.length} services`);
} catch (err) {
  // Never block a deploy over the index: the committed JSON stays in place.
  console.warn(`public index not rebuilt: ${err.message}`);
}
