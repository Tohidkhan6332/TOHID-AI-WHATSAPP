import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());

const port = Number(process.env.PORT || 3000);
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'TOHID-AI-WHATSAPP' });
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  // Acknowledge Meta quickly; processing can happen asynchronously later.
  res.sendStatus(200);

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from as string;
    const text = message.text?.body as string;
    if (!from || !text) return;

    const completion = await openai.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      input: [
        {
          role: 'system',
          content: 'You are TOHID-AI, a helpful WhatsApp AI assistant. Answer clearly and concisely unless the user asks for detail.'
        },
        { role: 'user', content: text }
      ]
    });

    const reply = completion.output_text?.trim() || 'Sorry, I could not generate a response.';

    if (supabase) {
      await supabase.from('messages').insert([
        { whatsapp_number: from, role: 'user', content: text },
        { whatsapp_number: from, role: 'assistant', content: reply }
      ]);
    }

    await sendWhatsAppMessage(from, reply);
  } catch (error) {
    console.error('Webhook processing error:', error);
  }
});

async function sendWhatsAppMessage(to: string, body: string) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.warn('WhatsApp credentials are not configured yet.');
    return;
  }

  const response = await fetch(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    })
  });

  if (!response.ok) {
    throw new Error(`WhatsApp API error: ${response.status} ${await response.text()}`);
  }
}

app.listen(port, () => {
  console.log(`TOHID-AI WhatsApp server listening on port ${port}`);
});
