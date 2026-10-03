# WhatsApp Webhook (Cloudflare Worker)

A lightweight, dependency-free webhook receiver for the **WhatsApp Business Cloud API** (Meta), running on **Cloudflare Workers**.

It handles Meta's webhook verification handshake, validates the `X-Hub-Signature-256` signature on every incoming event, and logs inbound messages and delivery status updates to Cloudflare Workers observability.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Configuration](#configuration)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [Connecting to Meta / WhatsApp](#connecting-to-meta--whatsapp)
- [API Reference](#api-reference)
- [Logging & Observability](#logging--observability)
- [Testing the Webhook Manually](#testing-the-webhook-manually)
- [Security Notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Extending the Worker](#extending-the-worker)

---

## Features

- **Subscription verification** – responds to Meta's `GET` handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`).
- **Signature validation** – verifies the HMAC-SHA256 `X-Hub-Signature-256` header against your Meta App Secret using the Web Crypto API.
- **Constant-time comparisons** – tokens and signatures are compared in constant time to avoid timing attacks.
- **Event parsing** – walks the `entry[].changes[].value` payload and logs:
  - inbound `messages` (sender, type, message ID, text body)
  - outbound `statuses` (message ID, status, recipient)
- **Fast acknowledgement** – always returns `200 EVENT_RECEIVED` for valid events so Meta doesn't retry.
- **Zero runtime dependencies** – a single `src/index.js` file; `wrangler` is the only dev dependency.

---

## How It Works

```
 ┌──────────────┐   GET /webhook?hub.*   ┌──────────────────────┐
 │              │ ─────────────────────▶ │                      │
 │  Meta / WA   │   ◀── hub.challenge ── │  Cloudflare Worker   │
 │  Cloud API   │                        │  (whatsapp-webhook)  │
 │              │   POST /webhook        │                      │
 │              │ ─────────────────────▶ │  1. verify signature │
 │              │   ◀── 200 EVENT_RECEIVED│  2. parse JSON       │
 └──────────────┘                        │  3. log events       │
                                         └──────────────────────┘
```

1. **Verification (`GET /webhook`)** – When you register the callback URL in the Meta dashboard, Meta sends a `GET` request with `hub.mode=subscribe`, your `hub.verify_token`, and a random `hub.challenge`. If the token matches `VERIFY_TOKEN`, the Worker echoes the challenge back with `200`; otherwise it returns `403`.
2. **Events (`POST /webhook`)** – Meta sends a JSON payload for each event. The Worker:
   - reads the raw body,
   - computes `sha256=<HMAC(APP_SECRET, body)>` and compares it to `X-Hub-Signature-256` (returns `401` on mismatch),
   - parses the JSON (returns `400` if invalid),
   - logs each message and status,
   - returns `200 EVENT_RECEIVED`.

Any path other than `/webhook` returns `404`; any method other than `GET`/`POST` returns `405`.

---

## Project Structure

```
.
├── src/
│   └── index.js        # Worker entry point (routing, verification, signature check, event logging)
├── wrangler.jsonc      # Cloudflare Worker configuration
├── package.json        # Dev dependency: wrangler
├── package-lock.json
├── .dev.vars           # Local secrets (git-ignored, create it yourself)
└── .gitignore
```

---

## Requirements

- [Node.js](https://nodejs.org/) 18 or later
- npm
- A [Cloudflare](https://dash.cloudflare.com/) account with Workers enabled
- A [Meta for Developers](https://developers.facebook.com/) app with the **WhatsApp** product added

Install dependencies:

```bash
npm install
```

---

## Configuration

### Worker settings (`wrangler.jsonc`)

| Key                  | Value                | Description                                      |
| -------------------- | -------------------- | ------------------------------------------------ |
| `name`               | `whatsapp-webhook`   | Worker name (determines the `*.workers.dev` URL) |
| `account_id`         | Cloudflare account   | Account the Worker is deployed to                |
| `main`               | `src/index.js`       | Entry point                                      |
| `compatibility_date` | `2026-10-01`         | Workers runtime compatibility date               |
| `observability`      | `{ "enabled": true }`| Enables Workers Logs for `console.*` output      |

### Secrets / environment variables

| Variable       | Required | Description                                                                                                  |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `VERIFY_TOKEN` | Yes      | Any string you choose. Must match the **Verify token** entered in the Meta webhook configuration.            |
| `APP_SECRET`   | Strongly recommended | Your Meta app's **App Secret** (App settings → Basic). Used to validate `X-Hub-Signature-256`. If unset, signatures are **not** verified and a warning is logged. |

#### Local (`.dev.vars`)

Create a `.dev.vars` file in the project root (it is git-ignored):

```ini
VERIFY_TOKEN=choose-a-long-random-string
APP_SECRET=your-meta-app-secret
```

#### Production (Wrangler secrets)

```bash
npx wrangler secret put VERIFY_TOKEN
```

```bash
npx wrangler secret put APP_SECRET
```

You'll be prompted to paste each value; they're stored encrypted in Cloudflare and never committed.

---

## Local Development

Start the local dev server:

```bash
npx wrangler dev
```

The Worker runs at `http://localhost:8787`. The webhook endpoint is:

```
http://localhost:8787/webhook
```

To let Meta reach your local machine during development, expose it with a tunnel, for example:

```bash
npx wrangler dev --remote
```

or use a tool such as `cloudflared tunnel --url http://localhost:8787` and register the generated HTTPS URL with Meta.

---

## Deployment

Log in to Cloudflare (first time only):

```bash
npx wrangler login
```

Deploy:

```bash
npx wrangler deploy
```

Wrangler prints the public URL, e.g.:

```
https://whatsapp-webhook.<your-subdomain>.workers.dev
```

Your callback URL is that address with `/webhook` appended.

Remember to set the production secrets (see [Configuration](#production-wrangler-secrets)) — they are **not** read from `.dev.vars` in production.

---

## Connecting to Meta / WhatsApp

1. Open your app at [developers.facebook.com/apps](https://developers.facebook.com/apps) and go to **WhatsApp → Configuration**.
2. Under **Webhook**, click **Edit** and enter:
   - **Callback URL:** `https://whatsapp-webhook.<your-subdomain>.workers.dev/webhook`
   - **Verify token:** the exact value of `VERIFY_TOKEN`
3. Click **Verify and save**. Meta calls `GET /webhook`; the Worker echoes the challenge and the webhook is saved.
4. Under **Webhook fields**, subscribe to **`messages`** (this covers both inbound messages and message status updates).
5. Copy the **App Secret** from **App settings → Basic** and store it as the `APP_SECRET` secret.
6. Send a WhatsApp message to your business test number and watch the logs.

---

## API Reference

### `GET /webhook`

Meta subscription verification.

| Query parameter    | Description                         |
| ------------------ | ----------------------------------- |
| `hub.mode`         | Must be `subscribe`                 |
| `hub.verify_token` | Must equal `VERIFY_TOKEN`           |
| `hub.challenge`    | Random string echoed back on success |

| Response | When                                    |
| -------- | --------------------------------------- |
| `200` + challenge (`text/plain`) | Mode and token are valid |
| `403 Forbidden` | Anything else                      |

### `POST /webhook`

Receives WhatsApp event notifications.

| Header                | Description                                     |
| --------------------- | ----------------------------------------------- |
| `X-Hub-Signature-256` | `sha256=<hex HMAC of raw body using APP_SECRET>` |

| Response                  | When                                           |
| ------------------------- | ---------------------------------------------- |
| `200 EVENT_RECEIVED`      | Signature valid (or `APP_SECRET` unset) and body is valid JSON |
| `400 Bad request`         | Body is not valid JSON                         |
| `401 Invalid signature`   | Signature missing or doesn't match             |

### Other routes

| Request                      | Response                  |
| ---------------------------- | ------------------------- |
| Any path other than `/webhook` | `404 Not found`         |
| `/webhook` with other methods  | `405 Method not allowed` |

---

## Logging & Observability

Observability is enabled in `wrangler.jsonc`, so all `console.log` output is available in the Cloudflare dashboard under **Workers & Pages → whatsapp-webhook → Logs**.

Stream logs live from the terminal:

```bash
npx wrangler tail
```

Example log lines:

```
message {"from":"15551234567","type":"text","id":"wamid.HBgL...","text":"Hello!"}
status  {"id":"wamid.HBgL...","status":"delivered","recipient":"15551234567"}
```

---

## Testing the Webhook Manually

### Verification handshake

```bash
curl -i "http://localhost:8787/webhook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345"
```

Expected: `200` with body `12345`.

### Signed event

Create a sample payload:

```bash
cat > /tmp/payload.json <<'EOF'
{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messages":[{"from":"15551234567","id":"wamid.TEST","type":"text","text":{"body":"Hello!"}}]}}]}]}
EOF
```

Compute the signature and send it:

```bash
SIG=$(openssl dgst -sha256 -hmac "YOUR_APP_SECRET" -hex < /tmp/payload.json | awk '{print $NF}'); curl -i -X POST http://localhost:8787/webhook -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" --data-binary @/tmp/payload.json
```

Expected: `200 EVENT_RECEIVED`, and a `message {...}` line in the dev server output.

---

## Security Notes

- **Always set `APP_SECRET` in production.** Without it, anyone who knows the URL can post fake events.
- Use a long, random `VERIFY_TOKEN` (e.g. `openssl rand -hex 32`).
- Never commit `.dev.vars` or any file containing secrets — they're excluded by `.gitignore`.
- The signature is computed over the **raw** request body; don't modify or re-serialize the body before verifying.
- Message contents are logged. If you handle sensitive conversations, reduce or redact what is logged in `receiveEvent`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| Meta says *"The callback URL or verify token couldn't be validated"* | `VERIFY_TOKEN` secret not set in production, value mismatch, or URL missing `/webhook`. |
| `401 Invalid signature` on real events | `APP_SECRET` is wrong (use the App Secret, not an access token) or belongs to a different Meta app. |
| No events arriving | The `messages` webhook field isn't subscribed, or the phone number/WABA isn't linked to the app. |
| `APP_SECRET not set` warning in logs | Run `npx wrangler secret put APP_SECRET`. |
| Meta keeps retrying the same event | The Worker returned a non-`200` response — check logs for `400`/`401`. |

---

## Extending the Worker

The event loop in `receiveEvent` (`src/index.js`) is the natural place to add business logic, for example:

- **Auto-replies** – call the Graph API `POST /{phone-number-id}/messages` with a WhatsApp access token stored as a secret.
- **Persistence** – write messages to [D1](https://developers.cloudflare.com/d1/), [KV](https://developers.cloudflare.com/kv/), or [R2](https://developers.cloudflare.com/r2/).
- **Async processing** – push events to [Cloudflare Queues](https://developers.cloudflare.com/queues/) or use `ctx.waitUntil()` so the `200` acknowledgement stays fast.
- **Other webhook fields** – handle template status, account updates, etc. by inspecting `change.field`.

Keep the response fast: Meta expects a `200` quickly and will retry otherwise.
