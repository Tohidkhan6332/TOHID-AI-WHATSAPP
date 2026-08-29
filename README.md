# TOHID-AI WhatsApp

Public WhatsApp AI assistant using OpenAI, Supabase and the unofficial Baileys WhatsApp Web client.

## Features

- Public pairing page
- Pairing-code login
- QR-code login
- Persistent Baileys auth state in Supabase
- Per-account and per-chat conversation memory
- Automatic reconnect after transient disconnects
- Heroku-compatible Node/TypeScript server

## Heroku Config Vars

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
LOG_LEVEL=silent
```

`PORT` is supplied by Heroku automatically.

## Supabase setup

Run `supabase/schema.sql` in the Supabase SQL Editor before the first pairing. The schema stores chat history and encrypted-at-rest-by-provider database records for Baileys authentication state. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.

## Deploy

1. Create a Heroku app and connect this GitHub repository.
2. Add the Config Vars above in Heroku Settings → Config Vars.
3. Deploy the `main` branch.
4. Open `/health` and confirm `ok: true`.
5. Open `/` for the public pairing page.
6. Enter the WhatsApp number with country code, digits only.
7. Choose Pairing Code or QR Code.
8. Complete linking in WhatsApp → Linked Devices.

## Important limitations

This project uses Baileys, an unofficial WhatsApp Web client. It is not affiliated with WhatsApp. Use only accounts you own or are authorized to operate. Do not use the service for spam, bulk unsolicited messaging, scraping, or abuse. WhatsApp may restrict or terminate accounts using unauthorized automation.

For a public service, add stronger production controls before opening it to the internet at scale: CAPTCHA/Turnstile, per-IP and per-number rate limits, session quotas, abuse monitoring, encrypted application-level session storage, and a persistent worker architecture. A single Heroku web dyno is not a high-availability multi-session platform.
