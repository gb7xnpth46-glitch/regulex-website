---
name: regulex-public-library
description: Search and read REGULEX public articles and newsletter issues on UAE law through its read-only API or MCP server, and cite them correctly.
---

# Search the REGULEX public library

Use this guide when a user asks what REGULEX has published on a UAE legal topic (corporate tax, VAT, free zones, DIFC and ADGM, company law, the weekly Regulex Legal Intelligence newsletter). It gives read-only access to public publications. It is not legal advice and gives no access to client records.

## Access

- MCP (Streamable HTTP): `https://regulex-legal.com/mcp` with the tools `search_publications`, `get_publication` and `list_services`.
- REST: `GET https://regulex-legal.com/api/v1/articles.json` (index, newest first). Read a publication by requesting its `url` with `Accept: text/markdown`.
- Documentation: `https://regulex-legal.com/api/v1/README.md`. OpenAPI: `https://regulex-legal.com/openapi.json`.

## Steps

1. Search with a few topic words, e.g. `search_publications` with `query: "corporate tax"`. Use `type: "newsletter"` for weekly updates or `"article"` for longer guides.
2. Check `datePublished`. UAE rules change often, so prefer the newest relevant item and tell the user how old it is.
3. Read the full text with `get_publication` before summarising. Do not summarise from the title or description alone.
4. Cite the publication title, its date and its `url`. Where the publication names an official source (FTA, Cabinet Decision, DIFC or ADGM registrar), point the user to that source for the current rule.
5. Present the content as general information. Do not state that it applies to the user's facts, and do not promise tax outcomes, approvals or timelines.
6. If the user wants advice on their own situation, use `list_services` to find the relevant service page and the public contact channels (WhatsApp or email). The user makes contact. Do not send messages, book meetings or submit personal data on the user's behalf without their explicit consent.

Only public, published information is available. There is no client portal, no protected API and no payment capability.
