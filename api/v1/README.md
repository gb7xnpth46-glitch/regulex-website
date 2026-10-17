# REGULEX Public Library API

Read-only access to public information published on regulex-legal.com:
articles and Regulex Legal Intelligence newsletter issues on UAE law, and
REGULEX service pages. No authentication, no client data, no write operations.

> General public information, not legal advice. Verify rules against current
> official sources. Scope and fees are agreed with REGULEX directly.

## REST (static JSON)

| Endpoint | Returns |
|---|---|
| `GET /api/v1/articles.json` | All publications, newest first: `slug`, `title`, `description`, `datePublished`, `type` (`article` or `newsletter`), `url` |
| `GET /api/v1/services.json` | Service pages and public contact channels |
| `GET /api/health.json` | `{"status": "ok"}` |

Full text: request a publication `url` with `Accept: text/markdown` to receive Markdown.

OpenAPI: <https://regulex-legal.com/openapi.json>

## MCP

Remote MCP server (Streamable HTTP, stateless): `https://regulex-legal.com/mcp`

Tools (all read-only):
- `search_publications` — search titles and summaries; optional `type` filter and `limit`.
- `get_publication` — full Markdown text of one publication by `slug`.
- `list_services` — service pages and contact channels. It does not contact REGULEX.

Server Card: <https://regulex-legal.com/mcp/server-card>

## Contact

WhatsApp <https://wa.me/971527229941> · info@regulex-legal.com.
Agents must not send messages on a user's behalf without the user's consent.
