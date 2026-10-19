# REGULEX auth.md

You are an AI agent. This file explains how to get permission to **send an enquiry to REGULEX Legal Consultancy on behalf of a person**. That is the only protected action on this site.

- Public content (articles, newsletters, service pages) needs no authentication: use `https://regulex-legal.com/llms.txt`, `https://regulex-legal.com/api/v1/articles.json` or the MCP server at `https://regulex-legal.com/mcp`.
- A token never lets you read anything from REGULEX. It only allows `POST https://regulex-legal.com/api/v1/inquiries`.
- A person must approve on regulex-legal.com before you can send anything. Do not send an enquiry the person has not asked for, and do not include confidential documents or other people's personal data.
- REGULEX replies by email or WhatsApp. Sending an enquiry does not create a lawyer-client relationship; scope and fees are agreed with REGULEX directly.

## Step 1: Discover

- Protected Resource Metadata: `GET https://regulex-legal.com/.well-known/oauth-protected-resource`
- Authorization Server metadata: `GET https://regulex-legal.com/.well-known/oauth-authorization-server`
- Signing keys: `GET https://regulex-legal.com/.well-known/jwks.json` (ES256)

A request to the API without a token returns `401` with
`WWW-Authenticate: Bearer resource_metadata="https://regulex-legal.com/.well-known/oauth-protected-resource", scope="inquiries:write"`.

Resource: `https://regulex-legal.com`. Scope: `inquiries:write`.

## Step 2: Pick a method

1. **You can open a browser for the person (OAuth client)**: use [OAuth 2.1 authorization code with PKCE](#method-a-oauth-authorization-code-with-pkce).
2. **You can only show the person a link and a code**: use [anonymous registration with the claim ceremony](#method-b-anonymous-registration-and-claim-ceremony).

`identity_assertion` (ID-JAG) and `service_auth` are not enabled; those requests return `issuer_not_enabled` and `service_auth_not_enabled`.

## Method A: OAuth authorization code with PKCE

1. Register a public client (RFC 7591):

```http
POST https://regulex-legal.com/oauth2/register
Content-Type: application/json

{ "client_name": "Your agent name", "redirect_uris": ["https://your.app/callback"] }
```

Redirect URIs must use `https`, or `http` on `127.0.0.1`, `[::1]` or `localhost`. The response contains your `client_id`.

2. Send the person to the authorization endpoint with PKCE (`S256` only):

```
https://regulex-legal.com/oauth2/authorize?response_type=code&client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&scope=inquiries:write&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&resource=https://regulex-legal.com
```

The person enters the email REGULEX should reply to, accepts the Privacy Policy and approves. You receive `code`, `state` and `iss` on your redirect URI. Check that `iss` is `https://regulex-legal.com`.

3. Exchange the code:

```http
POST https://regulex-legal.com/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=CODE&client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&code_verifier=VERIFIER
```

The access token lasts one hour. There are no refresh tokens: ask the person again if you need another token later.

## Method B: anonymous registration and claim ceremony

1. Register:

```http
POST https://regulex-legal.com/agent/identity
Content-Type: application/json

{ "type": "anonymous", "client_name": "Your agent name" }
```

The response has `registration_id`, `claim_token` (returned once; keep it in memory only), `claim_token_expires` (24 hours), `pre_claim_scopes: []` and `post_claim_scopes: ["inquiries:write"]`. There is no access before the claim.

2. Start the claim with the email of the person you act for:

```http
POST https://regulex-legal.com/agent/identity/claim
Content-Type: application/json

{ "claim_token": "clm_...", "email": "person@example.com" }
```

The response contains `claim_attempt.user_code`, `claim_attempt.verification_uri`, `expires_in` (600 seconds) and `interval` (5 seconds).

3. Show the person both in one message, for example:

> Open this link and enter the 6-digit code **123456** to let me contact REGULEX for you: https://regulex-legal.com/agent/claim?claim_attempt_token=...

The person sees your agent name and their email, types the code and accepts the Privacy Policy. REGULEX does not have user accounts, so this confirms that a person approved the request; it does not prove that they own the email address.

4. Poll the token endpoint, honouring `interval`:

```http
POST https://regulex-legal.com/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=clm_...
```

Responses: `authorization_pending` (keep waiting), `slow_down` (add 5 seconds), `expired_token` (call the claim endpoint again for a new code, or register again after 24 hours). On success you get `access_token` (one hour) plus `identity_assertion` (30 days). The claim succeeds once; after that use the assertion.

5. When the access token expires, exchange the assertion (RFC 7523):

```http
POST https://regulex-legal.com/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=IDENTITY_ASSERTION&resource=https://regulex-legal.com
```

## Step 3: Send the enquiry

```http
POST https://regulex-legal.com/api/v1/inquiries
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{
  "name": "Person's name",
  "phone": "+971 ...",
  "service": "Corporate Structuring",
  "message": "Short description of the legal matter, written or approved by the person."
}
```

- `name` and `message` are required; `phone` is optional.
- `service` is one of: `Corporate Structuring`, `International Arbitration`, `Commercial Contracts`, `Legal Drafting`, `Private Clients`, `Ongoing Advisory`, `Other`.
- The reply email is always the one the person confirmed. An `email` field in the body is ignored.
- At most 5 enquiries per hour per authorization.

Success: `201` with `{ "id": "inq_...", "status": "received", "reply_to": "...", "message": "..." }`. Tell the person that REGULEX will reply by email or WhatsApp.

## Revocation

`POST https://regulex-legal.com/oauth2/revoke` with `token=ACCESS_TOKEN` or `token=IDENTITY_ASSERTION` (form-encoded). It always returns `200`. Revoking an identity assertion ends the whole registration. The person can also ask REGULEX at info@regulex-legal.com to stop any agent access.

## Errors

| Code | Where | What to do |
| --- | --- | --- |
| `invalid_token` (401) | API | Get a new access token (Step 5 of Method B, or Method A again). |
| `insufficient_scope` (403) | API | Request scope `inquiries:write`. |
| `rate_limited` (429) | any | Back off and retry later. |
| `invalid_grant` | token | Code, assertion or claim is invalid, used or expired. Start again. |
| `authorization_pending`, `slow_down`, `expired_token` | token (claim grant) | See Method B, step 4. |
| `invalid_claim_token`, `claim_expired`, `claimed_or_in_flight` | claim | Register again, or use the tokens you already have. |

Privacy: https://regulex-legal.com/privacy. Questions: info@regulex-legal.com.
