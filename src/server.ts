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
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT || 3000);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const sessions = new Map<string, ReturnType<typeof makeWASocket>>();
const pendingQr = new Map<string, string>();
const pendingPairing = new Map<string, string>();
const connecting = new Set<string>();
const sessionTokens = new Map<string, string>();
const requestTimes = new Map<string, number>();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'TOHID-AI-WHATSAPP', sessions: sessions.size });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TOHID-AI WhatsApp</title>
<style>
body{margin:0;background:#0b0f14;color:#f5f7fa;font-family:system-ui,-apple-system,sans-serif}.wrap{max-width:520px;margin:0 auto;padding:28px 18px}.card{background:#121923;border:1px solid #263241;border-radius:20px;padding:22px;box-shadow:0 12px 40px #0005}.logo{font-size:34px;font-weight:800}.muted{color:#9aa7b5}.tabs{display:flex;gap:8px;margin:20px 0}.tab,button{border:0;border-radius:12px;padding:13px 16px;font-weight:700;cursor:pointer}.tab{flex:1;background:#1b2633;color:#cdd6df}.tab.active{background:#fff;color:#111}.panel{display:none}.panel.active{display:block}input{width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid #344252;background:#0d141d;color:#fff;font-size:16px;margin:8px 0 12px}button.primary{width:100%;background:#fff;color:#111;font-size:16px}.code{font-size:30px;letter-spacing:5px;text-align:center;font-weight:800;margin:20px 0}.status{text-align:center;margin:14px 0}.qr{display:block;width:260px;height:260px;margin:18px auto;background:#fff;border-radius:12px}.steps{line-height:1.65}.error{color:#ff8d8d;white-space:pre-wrap}.ok{color:#72e6a1}.small{font-size:13px}
</style></head>
<body><div class="wrap"><div class="card"><div class="logo">🤖 TOHID-AI</div><p class="muted">Connect your WhatsApp and turn it into an AI assistant.</p>
<div class="tabs"><button class="tab active" id="pairTab" onclick="show('pair')">Pairing Code</button><button class="tab" id="qrTab" onclick="show('qr')">QR Code</button></div>
<div id="pair" class="panel active"><input id="phone" inputmode="numeric" placeholder="WhatsApp number, e.g. 919876543210"><button class="primary" onclick="connect(true)">Generate Pairing Code</button><div id="pairResult"></div></div>
<div id="qr" class="panel"><button class="primary" onclick="connect(false)">Generate QR Code</button><div id="qrResult"></div></div>
<p class="muted small">Only connect WhatsApp accounts you own or are authorized to use. This service uses an unofficial WhatsApp Web client.</p>
</div></div>
<script>
let phone='', token='', timer=null;
function show(id){document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));document.getElementById(id).classList.add('active');document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.getElementById(id+'Tab').classList.add('active')}
async function connect(pairing){
 const input=document.getElementById('phone'); phone=(input?.value||'').replace(/\\D/g,'');
 if(!/^\\d{8,15}$/.test(phone)){alert('Enter WhatsApp number with country code, digits only.');return}
 const out=document.getElementById(pairing?'pairResult':'qrResult');out.innerHTML='<div class="status">Connecting…</div>';
 const r=await fetch('/api/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,mode:pairing?'pairing':'qr'})});
 const j=await r.json(); if(!r.ok){out.innerHTML='<div class="error">'+(j.error||'Connection failed')+'</div>';return}
 token=j.token||''; render(j,out); clearInterval(timer); timer=setInterval(poll,1500);
}
function render(j,out){let html='<div class="status">'+(j.connected?'<span class="ok">✓ WhatsApp connected</span>':'Waiting for WhatsApp…')+'</div>';
 if(j.pairingCode)html+='<div class="code">'+j.pairingCode+'</div><div class="steps">On your phone: <b>WhatsApp → Linked Devices → Link a device → Link with phone number instead</b>, then enter this code.</div>';
 if(j.qrDataUrl)html+='<img class="qr" src="'+j.qrDataUrl+'" alt="WhatsApp QR code"><div class="steps">On your phone: <b>WhatsApp → Linked Devices → Link a device</b>, then scan this QR.</div>';
 out.innerHTML=html;
}
async function poll(){if(!phone)return;const r=await fetch('/api/session/'+encodeURIComponent(phone));const j=await r.json();const out=document.getElementById(document.getElementById('pair').classList.contains('active')?'pairResult':'qrResult');render(j,out);if(j.connected){clearInterval(timer)}}
</script></body></html>`);
});

app.post('/api/connect', async (req, res) => {
  const phone = normalizePhone(String(req.body?.phone || ''));
  const mode = req.body?.mode === 'qr' ? 'qr' : 'pairing';
  if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid WhatsApp number with country code.' });
  const now = Date.now();
  const previous = requestTimes.get(phone) || 0;
  if (now - previous < 15000) return res.status(429).json({ error: 'Please wait a few seconds before requesting another connection.' });
  requestTimes.set(phone, now);
  try {
    const result = await startSession(phone, mode === 'pairing');
    const token = sessionTokens.get(phone) || crypto.randomBytes(24).toString('hex');
    sessionTokens.set(phone, token);
    return res.json({ ...result, token });
  } catch (error) {
    console.error('Connection error:', error);
    return res.status(500).json({ error: 'Could not create WhatsApp session.' });
  }
});

app.get('/api/session/:phone', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  res.json({ phone, connected: Boolean(sessions.get(phone)), pairingCode: pendingPairing.get(phone) || null, qrDataUrl: pendingQr.get(phone) || null, token: sessionTokens.get(phone) || null });
});

app.post('/api/session/:phone/logout', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (req.body?.token !== sessionTokens.get(phone)) return res.status(401).json({ error: 'Invalid session token' });
  const socket = sessions.get(phone);
  if (socket) await socket.logout().catch(() => undefined);
  sessions.delete(phone); pendingQr.delete(phone); pendingPairing.delete(phone); sessionTokens.delete(phone);
  await deleteAuthState(phone);
  res.json({ ok: true });
});

async function startSession(phone: string, requestPairing: boolean) {
  if (sessions.has(phone)) return { connected: true, phone };
  if (connecting.has(phone)) return { connecting: true, phone, pairingCode: pendingPairing.get(phone) || null, qrDataUrl: pendingQr.get(phone) || null };
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
      return { phone, connected: false, pairingCode: code, qrDataUrl: null, instructions: 'Link with phone number instead and enter the code.' };
    }
    return { phone, connected: Boolean(state.creds.registered), pairingCode: pendingPairing.get(phone) || null, qrDataUrl: pendingQr.get(phone) || null };
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
