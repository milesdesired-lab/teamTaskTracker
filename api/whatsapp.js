// api/whatsapp.js — Team WhatsApp webhook
// Identifies the sender by their whatsapp_number in the members table.
// Commands: list, all, done N, delete N, help — scoped to that member's tasks.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function db(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return null; }
}

function todayStr() {
  const IST = 5.5*60*60*1000;
  const d = new Date(Date.now() + IST);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function fmtDate(s) {
  if (!s || s === todayStr()) return 'Today';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'2-digit'});
}

function twiml(msg) {
  const safe = msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = '';
  if (typeof req.body === 'string') raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
  else raw = await new Promise((r, j) => { let d=''; req.on('data', c => d+=c); req.on('end', () => r(d)); req.on('error', j); });
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const [k,v] of params) obj[k] = v;
  return obj;
}

async function handle(from, raw) {
  // Find member by whatsapp number
  const members = await db('GET', `members?whatsapp_number=eq.${encodeURIComponent(from)}`);
  if (!members || !members.length) {
    return '❌ Your number is not registered. Open the Team Tasks web app and add your WhatsApp number in your profile.';
  }
  const member = members[0];
  const teamId = member.team_id;
  const lower = raw.trim().toLowerCase();

  // LIST
  if (lower === 'list' || lower === 'today') {
    const rows = await db('GET', `tasks?assigned_to=eq.${member.id}&done=eq.false&approved=eq.true&deadline_date=eq.${todayStr()}&order=urgent.desc,created_at.asc`);
    if (!rows || !rows.length) return `📭 No tasks for today, ${member.name}!`;
    const lines = rows.map((t,i) => `${i+1}. ${t.urgent?'🔴 ':''}${t.text}${t.deadline_time?' ⏰'+t.deadline_time.slice(0,5):''}`).join('\n');
    return `📋 *${member.name}'s tasks today:*\n\n${lines}\n\n_done N · all_`;
  }

  // ALL
  if (lower === 'all') {
    const rows = await db('GET', `tasks?assigned_to=eq.${member.id}&done=eq.false&approved=eq.true&order=deadline_date.asc,urgent.desc`);
    if (!rows || !rows.length) return '📭 No open tasks!';
    const lines = rows.map((t,i) => `${i+1}. ${t.urgent?'🔴 ':''}${t.text} _(${fmtDate(t.deadline_date)})_`).join('\n');
    return `📋 *All your tasks:*\n\n${lines}`;
  }

  // DONE N
  const doneM = raw.trim().match(/^done\s+(\d+)$/i);
  if (doneM) {
    const idx = parseInt(doneM[1]) - 1;
    const rows = await db('GET', `tasks?assigned_to=eq.${member.id}&done=eq.false&approved=eq.true&order=deadline_date.asc,created_at.asc`);
    if (!rows || idx < 0 || idx >= rows.length) return `❌ Task #${idx+1} not found. Send "all" to see tasks.`;
    await db('PATCH', `tasks?id=eq.${rows[idx].id}`, { done: true });
    return `✅ Done: _${rows[idx].text}_`;
  }

  // DELETE N
  const delM = raw.trim().match(/^(?:delete|del)\s+(\d+)$/i);
  if (delM) {
    const idx = parseInt(delM[1]) - 1;
    const rows = await db('GET', `tasks?assigned_to=eq.${member.id}&order=deadline_date.asc,created_at.asc`);
    if (!rows || idx < 0 || idx >= rows.length) return `❌ Task #${idx+1} not found.`;
    await db('DELETE', `tasks?id=eq.${rows[idx].id}`);
    return `🗑️ Deleted: _${rows[idx].text}_`;
  }

  // HELP
  if (['help','hi','hello','?','start'].includes(lower)) {
    return `👋 *Team Tasks — ${member.name}*\n\n*View:*\n• list — today's tasks\n• all — all your tasks\n\n*Update:*\n• done 2\n• delete 3\n\n_Add tasks from the web app_`;
  }

  // FALLBACK — add as a today task for self
  const text = raw.trim();
  if (!text) return '❌ Empty message. Send "help" for examples.';

  // Check if approval is required
  const teams = await db('GET', `teams?id=eq.${teamId}`);
  const team = teams && teams[0];
  const approved = team && team.approval_required ? (member.role === 'leader') : true;

  await db('POST', 'tasks', {
    team_id: teamId, created_by: member.id, assigned_to: member.id,
    text, urgent: false, deadline_type: 'today', deadline_date: todayStr(),
    done: false, approved, reminder_sent: false
  });
  return `✅ Added: _${text}_ for today${approved ? '' : ' (pending approval)'}`;
}

export default async function handler(req, res) {
  const sendReply = (text) => {
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    res.status(200).send(twiml(text));
  };
  if (req.method !== 'POST') return res.status(200).send('Team WhatsApp webhook. POST from Twilio expected.');
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return sendReply('⚠️ Server config error.');
    const body = await readBody(req);
    const from = body.From || '';
    const msg = (body.Body || '').trim();
    if (!msg) return sendReply('❌ Empty message.');
    const reply = await handle(from, msg);
    return sendReply(reply);
  } catch(err) {
    console.error('WA error:', err);
    return sendReply(`⚠️ Error: ${err.message || 'unknown'}`);
  }
}
