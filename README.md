# TOHID-AI WhatsApp

TOHID-AI is a ChatGPT-style WhatsApp bot using OpenAI, Supabase and the unofficial Baileys WhatsApp Web client. It supports persistent WhatsApp sessions, pairing-code login and QR-code state.

> Important: Baileys is an unofficial WhatsApp Web library and is not affiliated with WhatsApp. Use it only for accounts you control and comply with WhatsApp's Terms of Service. Avoid spam, bulk messaging and other abusive automation.

## Heroku Config Vars

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
PAIRING_ADMIN_TOKEN=...
LOG_LEVEL=silent
```

`PORT` is supplied by Heroku automatically.

## Supabase setup

Run `supabase/schema.sql` in Supabase SQL Editor. The schema stores chat memory and the Baileys authentication credentials/Signal keys so a Heroku restart does not require re-pairing.

Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.

## Deploy to Heroku

1. Create a Heroku app.
2. Connect this GitHub repository.
3. Add the Config Vars above in Heroku Settings → Config Vars.
4. Deploy the `main` branch.
5. Open `https://YOUR-APP.herokuapp.com/health`. It should return `ok: true`.
6. Open `https://YOUR-APP.herokuapp.com/`.
7. Enter your `PAIRING_ADMIN_TOKEN` and a WhatsApp number with country code, digits only, for example `919876543210`.
8. Tap **Generate pairing code**.
9. On that phone: WhatsApp → Linked Devices → Link a device → Link with phone number instead → enter the generated code.
10. Once connected, messages received by that WhatsApp account can be answered by TOHID-AI.

## QR

The server also captures WhatsApp QR data internally at `/api/session/:phone`. The current web page uses pairing code because it is easier to use on a remote Heroku dyno. A frontend can render the returned `qrDataUrl` if QR login is preferred.

## Security

Do not commit `.env`, OpenAI keys, Supabase service-role keys or WhatsApp authentication data. `PAIRING_ADMIN_TOKEN` is required before a new account can be paired. Use a long random value.
