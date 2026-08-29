import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import makeWASocket, {
  DisconnectReason,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  BufferJSON,
  Browsers,
  type AuthenticationCreds,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT || 3000);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const pairingAdminToken = process.env.PAIRING_ADMIN_TOKEN || '';

const sessions = new Map<string, ReturnType<typeof makeWASocket>>();
const pendingQr = new Map<string, string>();
const pendingPairing = new Map<string, string>();
const connecting = new Set<string>();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'TOHID-AI-WHATSAPP', sessions: sessions.size });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TOHID-AI WhatsApp</title><style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:20px}input,button{padding:12px;margin:5px 0;width:100%;box-sizing:border-box}button{cursor:pointer}.card{border:1px solid #ddd;border-radius:12px;padding:18px;margin-top:16px}img{max-width:280px;display:block;margin:15px auto}</style></head><body><h1>TOHID-AI WhatsApp</h1><p>Connect your WhatsApp using a pairing code.</p><div class="card"><input id="token" placeholder="Pairing admin token" type="password"><input id="phone" placeholder="Phone number with country code, e.g. 919876543210"><button onclick="pair()">Generate pairing code</button><pre id="out"></pre></div><script>async function pair(){const out=document.getElementById('out');out.textContent='Generating...';const r=await fetch('/api/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:document.getElementById('phone').value,token:document.getElementById('token').value})});const j=await r.json();out.textContent=JSON.stringify(j,null,2)}</script></body></html>`);
});

app.post('/api/pair', async (req, res) => {
  if (!pairingAdminToken || req.body?.token !== pairingAdminToken) {
    return res.status(401).json({ error: 'Invalid pairing token' });
  }
  const phone = normalizePhone(String(req.body?.phone || ''));
  if (!/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter phone number with country code, digits only, no + or spaces.' });
  }
  try {
    return res.json(await startSession(phone, true));
  } catch (error) {
    console.error('Pairing error:', error);
    return res.status(500).json({ error: 'Could not create WhatsApp session.' });
  }
});

app.get('/api/session/:phone', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  res.json({ phone, connected: Boolean(sessions.get(phone)), pairingCode: pendingPairing.get(phone) || null, qrDataUrl: pendingQr.get(phone) || null });
});

app.post('/api/session/:phone/logout', async (req, res) => {
  if (!pairingAdminToken || req.body?.token !== pairingAdminToken) return res.status(401).json({ error: 'Invalid pairing token' });
  const phone = normalizePhone(req.params.phone);
  const socket = sessions.get(phone);
  if (socket) await socket.logout().catch(() => undefined);
  sessions.delete(phone); pendingQr.delete(phone); pendingPairing.delete(phone);
  await deleteAuthState(phone);
  res.json({ ok: true });
});

async function startSession(phone: string, requestPairing: boolean) {
  if (sessions.has(phone)) return { connected: true, phone };
  if (connecting.has(phone)) return { connecting: true, phone, pairingCode: pendingPairing.get(phone) || null };
  connecting.add(phone);
  try {
    const { state, saveCreds } = await useSupabaseAuthState(phone);
    const socket = makeWASocket({ auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger, browser: Browsers.ubuntu('TOHID-AI'), markOnlineOnConnect: false, generateHighQualityLinkPreview: false });
    sessions.set(phone, socket);
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) pendingQr.set(phone, await QRCode.toDataURL(qr));
      if (connection === 'open') { pendingQr.delete(phone); pendingPairing.delete(phone); connecting.delete(phone); console.log(`WhatsApp connected: ${phone}`); }
      if (connection === 'close') {
        sessions.delete(phone); pendingQr.delete(phone); pendingPairing.delete(phone); connecting.delete(phone);
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) setTimeout(() => startSession(phone, false).catch(console.error), 3000);
      }
    });
    socket.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message || !msg.key.remoteJid) continue;
        const text = extractText(msg.message);
        if (text) await handleIncomingMessage(phone, socket, msg.key.remoteJid, text);
      }
    });
    if (requestPairing && !state.creds.registered) {
      const code = await socket.requestPairingCode(phone);
      pendingPairing.set(phone, code);
      return { phone, connected: false, pairingCode: code, instructions: 'WhatsApp → Linked Devices → Link a device → Link with phone number instead, then enter the code.' };
    }
    return { phone, connected: Boolean(state.creds.registered) };
  } finally {
    if (!sessions.has(phone)) connecting.delete(phone);
  }
}

async function handleIncomingMessage(sessionPhone: string, socket: ReturnType<typeof makeWASocket>, remoteJid: string, text: string) {
  try {
    const history = await getConversationHistory(sessionPhone, remoteJid);
    const completion = await openai.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      input: [
        { role: 'system', content: 'You are TOHID-AI, a helpful WhatsApp AI assistant. Answer clearly and naturally. Use the user\'s language when practical.' },
        ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: text },
      ],
    });
    const reply = completion.output_text?.trim() || 'Sorry, I could not generate a response.';
    await saveMessages(sessionPhone, remoteJid, text, reply);
    await socket.sendMessage(remoteJid, { text: reply });
  } catch (error) { console.error(`Message error for ${sessionPhone}:`, error); }
}

function extractText(message: any): string { return String(message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || '').trim(); }

async function getConversationHistory(sessionPhone: string, chatId: string) {
  if (!supabase) return [] as Array<{ role: string; content: string }>;
  const { data, error } = await supabase.from('messages').select('role, content, created_at').eq('session_phone', sessionPhone).eq('chat_id', chatId).order('created_at', { ascending: false }).limit(20);
  if (error) { console.error(error); return []; }
  return (data || []).reverse();
}

async function saveMessages(sessionPhone: string, chatId: string, userText: string, assistantText: string) {
  if (!supabase) return;
  const { error } = await supabase.from('messages').insert([
    { whatsapp_number: sessionPhone, session_phone: sessionPhone, chat_id: chatId, role: 'user', content: userText },
    { whatsapp_number: sessionPhone, session_phone: sessionPhone, chat_id: chatId, role: 'assistant', content: assistantText },
  ]);
  if (error) console.error('Supabase message save error:', error);
}

async function useSupabaseAuthState(sessionId: string) {
  if (!supabase) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  const { data: credRow } = await supabase.from('whatsapp_auth_creds').select('creds').eq('session_id', sessionId).maybeSingle();
  const creds: AuthenticationCreds = credRow?.creds ? JSON.parse(JSON.stringify(credRow.creds), BufferJSON.reviver) : initAuthCreds();
  const state = {
    creds,
    keys: {
      get: async (type: string, ids: string[]) => {
        const { data } = await supabase.from('whatsapp_auth_keys').select('key_id,value').eq('session_id', sessionId).eq('key_type', type).in('key_id', ids);
        const result: Record<string, any> = {};
        for (const row of data || []) result[row.key_id] = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
        return result;
      },
      set: async (data: Record<string, Record<string, any>>) => {
        for (const [type, values] of Object.entries(data)) {
          for (const [id, value] of Object.entries(values)) {
            if (value == null) await supabase.from('whatsapp_auth_keys').delete().eq('session_id', sessionId).eq('key_type', type).eq('key_id', id);
            else await supabase.from('whatsapp_auth_keys').upsert({ session_id: sessionId, key_type: type, key_id: id, value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)) }, { onConflict: 'session_id,key_type,key_id' });
          }
        }
      },
    },
  };
  const saveCreds = async () => { await supabase.from('whatsapp_auth_creds').upsert({ session_id: sessionId, creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)), updated_at: new Date().toISOString() }, { onConflict: 'session_id' }); };
  return { state, saveCreds };
}

async function deleteAuthState(sessionId: string) {
  if (!supabase) return;
  await supabase.from('whatsapp_auth_keys').delete().eq('session_id', sessionId);
  await supabase.from('whatsapp_auth_creds').delete().eq('session_id', sessionId);
}

function normalizePhone(phone: string) { return phone.replace(/\D/g, ''); }
app.listen(port, () => console.log(`TOHID-AI WhatsApp server listening on port ${port}`));
