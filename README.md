# TOHID-AI WhatsApp

ChatGPT-style WhatsApp AI bot using WhatsApp Cloud API, OpenAI, Supabase and Heroku.

## Required Heroku Config Vars

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

`PORT` is supplied by Heroku automatically.

## Deploy

1. Create a Heroku app.
2. Connect this GitHub repository or deploy it with Heroku Git.
3. Add all required Config Vars in Heroku Settings → Config Vars.
4. Deploy the `main` branch.
5. Open `/health` on the Heroku app URL. It should return JSON with `ok: true`.
6. In Meta WhatsApp Cloud API, configure the webhook URL as `https://YOUR-HEROKU-APP.herokuapp.com/webhook`.
7. Use the exact same value as `WHATSAPP_VERIFY_TOKEN` for Meta's verification token.
8. Subscribe the WhatsApp webhook to the `messages` field.

## Supabase

Run `supabase/schema.sql` in the Supabase SQL Editor before enabling memory. The backend uses the service-role key and therefore must never expose that key to a browser or client.

## Security

Never commit `.env`, API keys, WhatsApp access tokens, or Supabase service-role keys to GitHub. Put secrets only in Heroku Config Vars.
