import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import makeWASocket, { DisconnectReason, initAuthCreds, makeCacheableSignalKeyStore, BufferJSON, Browsers, type AuthenticationCreds } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '1mb' }));
const port = Number(process.env.PORT || 3000);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
const adminToken = process.env.PAIRING_ADMIN_TOKEN || '';
const allowedNumbers = () => new Set((process.env.ALLOWED_NUMBERS || '').split(',').map(normalizePhone).filter(Boolean));
const sessions = new Map<string, ReturnType<typeof makeWASocket>>();
const pendingPairing = new Map<string, string>();
const connecting = new Set<string>();
const sessionTokens = new Map<string, string>();
const requestTimes = new Map<string, number>();

app.get('/health', (_req, res) => res.json({ ok: true, service: 'TOHID-AI-WHATSAPP', sessions: sessions.size }));

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TOHID-AI WhatsApp</title><style>body{margin:0;background:#0b0f14;color:#f5f7fa;font-family:system-ui}.wrap{max-width:520px;margin:auto;padding:32px 18px}.card{background:#121923;border:1px solid #263241;border-radius:20px;padding:24px;box-shadow:0 12px 40px #0005}h1{margin:0 0 8px}p{color:#9aa7b5}input,button{width:100%;box-sizing:border-box;padding:14px;margin-top:12px;border-radius:12px;font-size:16px}input{border:1px solid #344252;background:#0d141d;color:#fff}button{border:0;background:#fff;color:#111;font-weight:800;cursor:pointer}.code{font-size:30px;letter-spacing:5px;text-align:center;font-weight:900;margin:22px 0}.status{text-align:center;margin-top:18px}.ok{color:#72e6a1}.error{color:#ff8d8d;margin-top:16px}.steps{line-height:1.7;margin-top:15px}.small{font-size:13px}</style></head><body><div class="wrap"><div class="card"><h1>🤖 TOHID-AI</h1><p>Connect an approved WhatsApp number using a pairing code.</p><input id="phone" inputmode="numeric" placeholder="WhatsApp number, e.g. 919876543210"><button onclick="connect()">Generate Pairing Code</button><div id="out"></div><p class="small">Only numbers approved by the administrator can connect.</p></div></div><script>let phone='',timer=null;async function connect(){phone=(document.getElementById('phone').value||'').replace(/\\D/g,'');const out=document.getElementById('out');if(!/^\\d{8,15}$/.test(phone)){out.innerHTML='<div class="error">Enter a valid number with country code.</div>';return}out.innerHTML='<div class="status">Checking approval…</div>';const r=await fetch('/api/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone})});const j=await r.json();if(!r.ok){out.innerHTML='<div class="error">'+(j.error||'Connection failed')+'</div>';return}render(j);clearInterval(timer);timer=setInterval(poll,1500)}function render(j){const out=document.getElementById('out');let h='<div class="status">'+(j.connected?'<span class="ok">✓ WhatsApp connected</span>':'Waiting for WhatsApp…')+'</div>';if(j.pairingCode)h+='<div class="code">'+j.pairingCode+'</div><div class="steps"><b>WhatsApp → Linked Devices → Link a device → Link with phone number instead</b><br>Enter the pairing code shown above.</div>';out.innerHTML=h}async function poll(){if(!phone)return;const r=await fetch('/api/session/'+encodeURIComponent(phone));const j=await r.json();if(r.ok)render(j);if(j.connected)clearInterval(timer)}</script></body></html>`);
});

app.post('/api/connect', async (req, res) => {
  const phone = normalizePhone(String(req.body?.phone || ''));
  if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid WhatsApp number with country code.' });
  if (!allowedNumbers().has(phone)) return res.status(403).json({ error: 'This number is not approved. Ask the administrator to allow it first.' });
  const now = Date.now();
  if (now - (requestTimes.get(phone) || 0) < 15000) return res.status(429).json({ error: 'Please wait before requesting another pairing code.' });
  requestTimes.set(phone, now);
  try { const result = await startSession(phone); const token = sessionTokens.get(phone) || crypto.randomBytes(24).toString('hex'); sessionTokens.set(phone, token); return res.json({ ...result, token }); }
  catch (error) { console.error('Pairing error:', error); return res.status(500).json({ error: 'Could not create WhatsApp session.' }); }
});

app.get('/api/session/:phone', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!allowedNumbers().has(phone)) return res.status(403).json({ error: 'Number is not approved.' });
  res.json({ phone, connected: Boolean(sessions.get(phone)), pairingCode: pendingPairing.get(phone) || null });
});

app.post('/api/admin/allow', async (req, res) => {
  if (!adminToken || req.body?.adminToken !== adminToken) return res.status(401).json({ error: 'Invalid admin token' });
  const phone = normalizePhone(String(req.body?.phone || ''));
  if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone number.' });
  res.json({ ok: true, message: `Add ${phone} to ALLOWED_NUMBERS in Heroku Config Vars, then restart the app.` });
});

app.post('/api/session/:phone/logout', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!allowedNumbers().has(phone)) return res.status(403).json({ error: 'Number is not approved.' });
  if (req.body?.token !== sessionTokens.get(phone)) return res.status(401).json({ error: 'Invalid session token' });
  const socket = sessions.get(phone); if (socket) await socket.logout().catch(() => undefined);
  sessions.delete(phone); pendingPairing.delete(phone); sessionTokens.delete(phone); await deleteAuthState(phone); res.json({ ok: true });
});

async function startSession(phone: string) {
  if (sessions.has(phone)) return { connected: true, phone };
  if (connecting.has(phone)) return { connecting: true, phone, pairingCode: pendingPairing.get(phone) || null };
  connecting.add(phone);
  try {
    const { state, saveCreds } = await useSupabaseAuthState(phone);
    const socket = makeWASocket({ auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger, browser: Browsers.ubuntu('TOHID-AI'), markOnlineOnConnect: false });
    sessions.set(phone, socket); socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') { pendingPairing.delete(phone); connecting.delete(phone); console.log(`WhatsApp connected: ${phone}`); }
      if (connection === 'close') { sessions.delete(phone); pendingPairing.delete(phone); connecting.delete(phone); const code = (lastDisconnect?.error as Boom)?.output?.statusCode; if (code !== DisconnectReason.loggedOut) setTimeout(() => startSession(phone).catch(console.error), 3000); }
    });
    socket.ev.on('messages.upsert', async ({ messages }) => { for (const msg of messages) { if (msg.key.fromMe || !msg.message || !msg.key.remoteJid) continue; const text = extractText(msg.message); if (text) await handleIncomingMessage(phone, socket, msg.key.remoteJid, text); } });
    if (!state.creds.registered) { const code = await socket.requestPairingCode(phone); pendingPairing.set(phone, code); return { phone, connected: false, pairingCode: code }; }
    return { phone, connected: true };
  } finally { if (!sessions.has(phone)) connecting.delete(phone); }
}

async function handleIncomingMessage(sessionPhone: string, socket: ReturnType<typeof makeWASocket>, remoteJid: string, text: string) {
  try { const history = await getConversationHistory(sessionPhone, remoteJid); const completion = await openai.responses.create({ model: process.env.OPENAI_MODEL || 'gpt-5-mini', input: [{ role: 'system', content: 'You are TOHID-AI, a helpful WhatsApp AI assistant. Answer clearly and naturally. Use the user\'s language when practical.' }, ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })), { role: 'user', content: text }] }); const reply = completion.output_text?.trim() || 'Sorry, I could not generate a response.'; await saveMessages(sessionPhone, remoteJid, text, reply); await socket.sendMessage(remoteJid, { text: reply }); } catch (error) { console.error(`Message error for ${sessionPhone}:`, error); }
}
function extractText(message: any): string { return String(message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || '').trim(); }
async function getConversationHistory(sessionPhone: string, chatId: string) { if (!supabase) return []; const { data, error } = await supabase.from('messages').select('role,content,created_at').eq('session_phone', sessionPhone).eq('chat_id', chatId).order('created_at',{ascending:false}).limit(20); if(error){console.error(error);return [];} return (data||[]).reverse(); }
async function saveMessages(sessionPhone:string,chatId:string,userText:string,assistantText:string){if(!supabase)return;const {error}=await supabase.from('messages').insert([{session_phone:sessionPhone,chat_id:chatId,role:'user',content:userText},{session_phone:sessionPhone,chat_id:chatId,role:'assistant',content:assistantText}]);if(error)console.error('Supabase message save error:',error)}
async function useSupabaseAuthState(sessionId:string){if(!supabase)throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');const {data:credRow}=await supabase.from('whatsapp_auth_creds').select('creds').eq('session_id',sessionId).maybeSingle();const creds:AuthenticationCreds=credRow?.creds?JSON.parse(JSON.stringify(credRow.creds),BufferJSON.reviver):initAuthCreds();const state={creds,keys:{get:async(type:string,ids:string[])=>{const {data}=await supabase.from('whatsapp_auth_keys').select('key_id,value').eq('session_id',sessionId).eq('key_type',type).in('key_id',ids);const r:Record<string,any>={};for(const row of data||[])r[row.key_id]=JSON.parse(JSON.stringify(row.value),BufferJSON.reviver);return r},set:async(data:Record<string,Record<string,any>>)=>{for(const[type,values]of Object.entries(data))for(const[id,value]of Object.entries(values)){if(value==null)await supabase.from('whatsapp_auth_keys').delete().eq('session_id',sessionId).eq('key_type',type).eq('key_id',id);else await supabase.from('whatsapp_auth_keys').upsert({session_id:sessionId,key_type:type,key_id:id,value:JSON.parse(JSON.stringify(value,BufferJSON.replacer))},{onConflict:'session_id,key_type,key_id'})}}}};const saveCreds=async()=>{await supabase.from('whatsapp_auth_creds').upsert({session_id:sessionId,creds:JSON.parse(JSON.stringify(creds,BufferJSON.replacer)),updated_at:new Date().toISOString()},{onConflict:'session_id'});};return{state,saveCreds}}
async function deleteAuthState(sessionId:string){if(!supabase)return;await supabase.from('whatsapp_auth_keys').delete().eq('session_id',sessionId);await supabase.from('whatsapp_auth_creds').delete().eq('session_id',sessionId)}
function normalizePhone(phone:string){return phone.replace(/\D/g,'')}
app.listen(port,()=>console.log(`TOHID-AI WhatsApp server listening on port ${port}`));
