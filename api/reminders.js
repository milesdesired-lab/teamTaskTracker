// api/reminders.js — daily cron at 9 AM IST (3:30 UTC)
// Per-team: remind each member of their tasks due today, leader gets summary.
// On 1st of month: export per-member + combined CSV, purge old tasks.

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const TWILIO_SID       = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const CRON_SECRET      = process.env.CRON_SECRET;

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

async function sendWA(toNumber, msg) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_WA_NUMBER || !toNumber) return;
  const creds = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: TWILIO_WA_NUMBER, To: toNumber, Body: msg })
  });
  if (!res.ok) console.error('Twilio error:', await res.text());
}

const IST_MS = 5.5 * 60 * 60 * 1000;
function istNow() { return new Date(Date.now() + IST_MS); }
function todayIst() {
  const d = istNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function csvEscape(s) {
  if (!s) return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"'+s.replace(/"/g,'""')+'"';
  return s;
}

function tasksToCsv(rows, memberMap) {
  const h = ['Task','Assigned to','Status','Urgent','Type','Date','Time','Created'];
  const lines = [h.join(',')];
  for (const t of rows) {
    lines.push([
      csvEscape(t.text), csvEscape(memberMap[t.assigned_to] || '?'),
      t.done ? 'Done' : 'Pending', t.urgent ? 'Yes' : 'No',
      t.deadline_type === 'today' ? 'Today' : 'Scheduled',
      t.deadline_date || '', t.deadline_time ? t.deadline_time.slice(0,5) : '',
      t.created_at ? t.created_at.slice(0,16).replace('T',' ') : ''
    ].join(','));
  }
  return lines.join('\n');
}

async function uploadCsv(filename, csv) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/reports/${filename}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'text/csv', 'x-upsert': 'true' },
    body: csv
  });
  if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
}

async function deleteTasks(ids) {
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    await db('DELETE', `tasks?id=in.(${batch.join(',')})`);
  }
}

export default async function handler(req, res) {
  const authH = req.headers['authorization'] || '';
  const qs = (req.query && req.query.secret) || '';
  const ok = CRON_SECRET ? (authH === `Bearer ${CRON_SECRET}` || qs === CRON_SECRET) : true;
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Missing env' });

  const ist = istNow();
  const today = todayIst();
  const istDay = ist.getUTCDate();
  const istMonth = ist.getUTCMonth();
  const istYear = ist.getUTCFullYear();
  const log = [];

  try {
    const allTeams = await db('GET', 'teams');

    for (const team of (allTeams || [])) {
      const members = await db('GET', `members?team_id=eq.${team.id}`);
      if (!members || !members.length) continue;
      const memberMap = {};
      members.forEach(m => memberMap[m.id] = m.name);
      const leader = members.find(m => m.role === 'leader');

      // ── 1. DAILY REMINDERS per member
      const todayTasks = await db('GET',
        `tasks?team_id=eq.${team.id}&done=eq.false&approved=eq.true&deadline_date=eq.${today}&order=urgent.desc`
      );
      if (todayTasks && todayTasks.length) {
        // Group by assigned_to
        const byMember = {};
        for (const t of todayTasks) {
          if (!byMember[t.assigned_to]) byMember[t.assigned_to] = [];
          byMember[t.assigned_to].push(t);
        }
        // Send to each member
        for (const m of members) {
          if (!m.whatsapp_number || !byMember[m.id]) continue;
          const lines = byMember[m.id].map((t,i) =>
            `${i+1}. ${t.urgent?'🔴 ':''}${t.text}`
          ).join('\n');
          await sendWA(m.whatsapp_number, `☀️ *Good morning ${m.name}!* Today's tasks:\n\n${lines}`);
          log.push(`reminded ${m.name} (${byMember[m.id].length} tasks)`);
        }
        // Leader summary
        if (leader && leader.whatsapp_number) {
          const summary = members.map(m => {
            const count = (byMember[m.id] || []).length;
            return count ? `${m.name}: ${count} task${count > 1 ? 's' : ''}` : null;
          }).filter(Boolean).join('\n');
          if (summary) {
            await sendWA(leader.whatsapp_number, `📊 *Team tasks for today:*\n\n${summary}\nTotal: ${todayTasks.length}`);
          }
        }
      }

      // ── 2. MARK REMINDERS SENT for dated tasks due today
      const datedDueToday = await db('GET',
        `tasks?team_id=eq.${team.id}&done=eq.false&approved=eq.true&reminder_sent=eq.false&deadline_type=eq.date&deadline_date=eq.${today}`
      );
      for (const t of (datedDueToday || [])) {
        await db('PATCH', `tasks?id=eq.${t.id}`, { reminder_sent: true });
      }

      // ── 3. AUTO-DELETE expired today-tasks
      const expired = await db('GET', `tasks?team_id=eq.${team.id}&deadline_type=eq.today&deadline_date=lt.${today}`);
      if (expired && expired.length) {
        await deleteTasks(expired.map(t => t.id));
        log.push(`deleted ${expired.length} expired tasks (${team.name})`);
      }

      // ── 4. MONTHLY EXPORT on 1st
      if (istDay === 1) {
        const prevMonth = istMonth === 0 ? 12 : istMonth;
        const prevYear = istMonth === 0 ? istYear - 1 : istYear;
        const startDate = `${prevYear}-${String(prevMonth).padStart(2,'0')}-01`;
        const endDate = `${istYear}-${String(istMonth+1).padStart(2,'0')}-01`;

        const monthTasks = await db('GET',
          `tasks?team_id=eq.${team.id}&deadline_date=gte.${startDate}&deadline_date=lt.${endDate}&order=deadline_date.asc`
        );
        if (monthTasks && monthTasks.length) {
          // Per-member CSVs
          for (const m of members) {
            const mTasks = monthTasks.filter(t => t.assigned_to === m.id);
            if (!mTasks.length) continue;
            const csv = tasksToCsv(mTasks, memberMap);
            const fn = `${team.name}-${m.name}-${MN[prevMonth-1]}-${prevYear}.csv`;
            await uploadCsv(fn.replace(/\s+/g, '-'), csv);
          }
          // Combined leader CSV
          const allCsv = tasksToCsv(monthTasks, memberMap);
          const fn = `${team.name}-ALL-${MN[prevMonth-1]}-${prevYear}.csv`;
          await uploadCsv(fn.replace(/\s+/g, '-'), allCsv);

          // Purge
          await deleteTasks(monthTasks.map(t => t.id));

          // Notify
          const done = monthTasks.filter(t => t.done).length;
          if (leader && leader.whatsapp_number) {
            await sendWA(leader.whatsapp_number,
              `📊 *${MN[prevMonth-1]} ${prevYear} report — ${team.name}*\n\n${monthTasks.length} tasks archived (${done} done, ${monthTasks.length-done} pending)\nCSVs saved.`
            );
          }
          log.push(`exported ${monthTasks.length} tasks for ${team.name}`);
        }
      }
    }

    return res.json({ ok: true, today, log });
  } catch(err) {
    console.error('Reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
}
