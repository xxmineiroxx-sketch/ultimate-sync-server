/**
 * Ultimate Ecosystem Sync Server v3
 * PostgreSQL persistence — Railway ready
 */

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8099;
const DB_URL = process.env.DATABASE_URL || '';
const pool = DB_URL ? new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
}) : null;

// ── In-memory store (warm cache) ────────────────────────────────────────────
let store = {
  services: [], plans: {}, people: [], messages: [],
  grants: {}, proposals: [], blockouts: [],
  assignmentResponses: {}, songLibrary: {},
};

// ── PostgreSQL persistence ───────────────────────────────────────────────────
async function initDB() {
  if (!pool) {
    console.log('[boot] No DATABASE_URL — running in-memory only (data will not persist across restarts)');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_store (
      id   TEXT PRIMARY KEY DEFAULT 'main',
      data JSONB NOT NULL
    );
  `);
  const r = await pool.query(`SELECT data FROM sync_store WHERE id = 'main'`);
  if (r.rows[0]) {
    const loaded = r.rows[0].data;
    store = { ...store, ...loaded };
    if (!store.grants)              store.grants              = {};
    if (!store.proposals)           store.proposals           = [];
    if (!store.blockouts)           store.blockouts           = [];
    if (!store.assignmentResponses) store.assignmentResponses = {};
    if (!store.songLibrary)         store.songLibrary         = {};
    console.log(`[boot] Loaded: ${store.services.length} services, ${store.people.length} people`);
  } else {
    console.log('[boot] Fresh DB — ready');
  }
}

async function persist() {
  if (!pool) return; // in-memory mode
  await pool.query(
    `INSERT INTO sync_store (id, data) VALUES ('main', $1)
     ON CONFLICT (id) DO UPDATE SET data = $1`,
    [store]
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function findPerson(email) {
  if (!email) return null;
  const q = email.trim().toLowerCase();
  const namePrefix = q.split('@')[0].replace(/[._]/g, ' ');
  return store.people.find(p => {
    const pe = (p.email || '').toLowerCase();
    const pn = (p.name  || '').toLowerCase();
    return pe === q || pn === q || pn === namePrefix;
  }) || null;
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors());

// ── POST /sync/publish ───────────────────────────────────────────────────────
app.post('/sync/publish', async (req, res) => {
  try {
    const body = req.body;
    if (body.services) {
      for (const svc of body.services) {
        const idx = store.services.findIndex(s => s.id === svc.id);
        if (idx >= 0) store.services[idx] = svc;
        else store.services.push(svc);
      }
    }
    if (body.people) {
      for (const person of body.people) {
        const idx = store.people.findIndex(p => p.id === person.id);
        if (idx >= 0) store.people[idx] = person;
        else store.people.push(person);
      }
    }
    if (body.plans) Object.assign(store.plans, body.plans);
    await persist();
    console.log(`[publish] ${store.services.length} services, ${store.people.length} people`);
    res.json({ ok: true, services: store.services.length, people: store.people.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /sync/assignments?email= ─────────────────────────────────────────────
app.get('/sync/assignments', (req, res) => {
  const email  = req.query.email || '';
  const person = findPerson(email);
  const assignments = [];
  if (person) {
    const serviceMap = {};
    for (const svc of store.services) serviceMap[svc.id] = svc;
    for (const planId of Object.keys(store.plans)) {
      if (!serviceMap[planId])
        serviceMap[planId] = { id: planId, name: 'Service', date: '', time: '', serviceType: 'standard' };
    }
    for (const svc of Object.values(serviceMap)) {
      const plan    = store.plans[svc.id] || {};
      const team    = plan.team || [];
      const matches = team.filter(t => t.personId === person.id);
      if (matches.length > 0) {
        assignments.push({
          id:           `${svc.id}_${person.id}`,
          service_id:   svc.id,
          service_name: svc.name || svc.title || 'Service',
          service_date: svc.date,
          service_time: svc.time || '',
          service_type: svc.serviceType || 'standard',
          role:         matches[0].role,
          roles:        matches.map(m => m.role),
          notes:        plan.notes || '',
          status:       'pending',
        });
      }
    }
  }
  res.json(assignments);
});

// ── GET /sync/setlist?serviceId= ─────────────────────────────────────────────
app.get('/sync/setlist', (req, res) => {
  const plan  = store.plans[req.query.serviceId || ''] || { songs: [] };
  const songs = (plan.songs || []).map((s, idx) => ({
    id:              s.id || `song_${idx}`,
    order:           idx + 1,
    title:           s.title || s.songTitle || 'Unknown',
    artist:          s.artist || '',
    key:             s.key || s.originalKey || '',
    tempo:           s.tempo || s.bpm || '',
    lyrics:          s.lyrics || '',
    chordChart:      s.chordChart || s.chordSheet || '',
    instrumentNotes: s.instrumentNotes || {},
    notes:           s.notes || s.hint || '',
    hasLyrics:       !!(s.lyrics),
    hasChordChart:   !!(s.chordChart || s.chordSheet),
  }));
  res.json(songs);
});

// ── POST /sync/message ───────────────────────────────────────────────────────
app.post('/sync/message', async (req, res) => {
  try {
    const body = req.body;
    const msg  = {
      id:         `msg_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
      from_email: (body.from_email || '').trim(),
      from_name:  (body.from_name  || 'Team Member').trim(),
      subject:    (body.subject    || '(no subject)').trim(),
      message:    (body.message    || '').trim(),
      to:         body.to === 'all_team' ? 'all_team' : 'admin',
      timestamp:  new Date().toISOString(),
      read:       false,
      replies:    [],
    };
    store.messages.unshift(msg);
    await persist();
    res.json({ ok: true, id: msg.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /sync/messages/admin ─────────────────────────────────────────────────
app.get('/sync/messages/admin', (req, res) => res.json(store.messages || []));

// ── POST /sync/message/reply?messageId= ─────────────────────────────────────
app.post('/sync/message/reply', async (req, res) => {
  try {
    const msg = (store.messages || []).find(m => m.id === (req.query.messageId || ''));
    if (!msg) return res.status(404).json({ error: 'message not found' });
    msg.replies.push({
      id:        `reply_${Date.now()}`,
      from:      (req.body.admin_name || 'Admin').trim(),
      message:   (req.body.reply_text || '').trim(),
      timestamp: new Date().toISOString(),
    });
    msg.read = true;
    await persist();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /sync/messages/replies?email= ───────────────────────────────────────
app.get('/sync/messages/replies', (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  const mine  = (store.messages || []).filter(m =>
    (m.from_email || '').toLowerCase() === email || m.to === 'all_team'
  );
  res.json(mine);
});

// ── GET /sync/people ─────────────────────────────────────────────────────────
app.get('/sync/people', (req, res) => res.json(store.people || []));

// ── GET /sync/grants ─────────────────────────────────────────────────────────
app.get('/sync/grants', (req, res) => {
  const list = Object.entries(store.grants || {}).map(([email, g]) => ({ email, ...g }));
  res.json(list);
});

// ── POST /sync/grant ─────────────────────────────────────────────────────────
app.post('/sync/grant', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!store.grants) store.grants = {};
    store.grants[email] = {
      name:      (req.body.name || email).trim(),
      role:      req.body.role || 'md',
      grantedAt: new Date().toISOString(),
    };
    await persist();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE /sync/grant?email= ────────────────────────────────────────────────
app.delete('/sync/grant', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (store.grants) delete store.grants[email];
  await persist();
  res.json({ ok: true });
});

// ── GET /sync/role?email= ────────────────────────────────────────────────────
app.get('/sync/role', (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  const grant = (store.grants || {})[email];
  res.json({ role: grant?.role || null, name: grant?.name || null });
});

// ── POST /sync/proposal ──────────────────────────────────────────────────────
app.post('/sync/proposal', async (req, res) => {
  try {
    const body     = req.body;
    const proposal = {
      id:         `prop_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
      songId:     (body.songId     || '').trim(),
      serviceId:  (body.serviceId  || '').trim(),
      type:       body.type === 'chord_chart' ? 'chord_chart' : 'lyrics',
      instrument: (body.instrument || '').trim(),
      content:    (body.content    || '').trim(),
      from_email: (body.from_email || '').trim(),
      from_name:  (body.from_name  || 'Team Member').trim(),
      songTitle:  (body.songTitle  || '').trim(),
      songArtist: (body.songArtist || '').trim(),
      status:     'pending',
      createdAt:  new Date().toISOString(),
    };
    if (!store.proposals) store.proposals = [];
    store.proposals.unshift(proposal);
    await persist();
    res.json({ ok: true, id: proposal.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /sync/proposals ──────────────────────────────────────────────────────
app.get('/sync/proposals', (req, res) => {
  const status = req.query.status || '';
  const list   = (store.proposals || []);
  res.json(status ? list.filter(p => p.status === status) : list);
});

// ── POST /sync/proposal/approve?id= ─────────────────────────────────────────
app.post('/sync/proposal/approve', async (req, res) => {
  try {
    const proposal = (store.proposals || []).find(p => p.id === (req.query.id || ''));
    if (!proposal) return res.status(404).json({ error: 'proposal not found' });
    proposal.status     = 'approved';
    proposal.approvedAt = new Date().toISOString();
    const plan     = store.plans[proposal.serviceId];
    const planSong = plan ? (plan.songs || []).find(s => s.id === proposal.songId) : null;
    if (planSong) {
      if (proposal.instrument) {
        if (!planSong.instrumentNotes) planSong.instrumentNotes = {};
        planSong.instrumentNotes[proposal.instrument] = proposal.content;
      } else if (proposal.type === 'lyrics') {
        planSong.lyrics = proposal.content;
      } else {
        planSong.chordChart = proposal.content;
        planSong.chordSheet = proposal.content;
      }
    }
    if (!store.songLibrary) store.songLibrary = {};
    if (!store.songLibrary[proposal.songId]) {
      store.songLibrary[proposal.songId] = {
        id: proposal.songId, title: proposal.songTitle || planSong?.title || '',
        artist: proposal.songArtist || planSong?.artist || '',
        key: planSong?.key || '', bpm: planSong?.bpm || '',
        lyrics: planSong?.lyrics || null, chordChart: planSong?.chordChart || null,
        instrumentNotes: { ...(planSong?.instrumentNotes || {}) },
        updatedAt: new Date().toISOString(),
      };
    }
    const libSong = store.songLibrary[proposal.songId];
    libSong.updatedAt = new Date().toISOString();
    if (proposal.instrument) {
      if (!libSong.instrumentNotes) libSong.instrumentNotes = {};
      libSong.instrumentNotes[proposal.instrument] = proposal.content;
    } else if (proposal.type === 'lyrics') {
      libSong.lyrics = proposal.content;
    } else {
      libSong.chordChart = proposal.content;
      libSong.chordSheet = proposal.content;
    }
    await persist();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /sync/proposal/reject?id= ──────────────────────────────────────────
app.post('/sync/proposal/reject', async (req, res) => {
  try {
    const proposal = (store.proposals || []).find(p => p.id === (req.query.id || ''));
    if (!proposal) return res.status(404).json({ error: 'proposal not found' });
    proposal.status       = 'rejected';
    proposal.rejectedAt   = new Date().toISOString();
    proposal.rejectReason = (req.body.reason || '').trim();
    await persist();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /sync/blockout ──────────────────────────────────────────────────────
app.post('/sync/blockout', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!store.blockouts) store.blockouts = [];
    const entry = {
      id:         req.body.id || `blk_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
      email, name: (req.body.name || email).trim(),
      date:       (req.body.date   || '').trim(),
      reason:     (req.body.reason || 'Not available').trim(),
      created_at: new Date().toISOString(),
    };
    store.blockouts = store.blockouts.filter(b => !(b.email === email && b.date === entry.date));
    store.blockouts.push(entry);
    await persist();
    res.json({ ok: true, id: entry.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE /sync/blockout ────────────────────────────────────────────────────
app.delete('/sync/blockout', async (req, res) => {
  if (!store.blockouts) store.blockouts = [];
  const blkId = req.query.id    || '';
  const email = (req.query.email || '').trim().toLowerCase();
  const date  = req.query.date   || '';
  if (blkId)          store.blockouts = store.blockouts.filter(b => b.id !== blkId);
  else if (email && date) store.blockouts = store.blockouts.filter(b => !(b.email === email && b.date === date));
  await persist();
  res.json({ ok: true });
});

// ── GET /sync/blockouts ──────────────────────────────────────────────────────
app.get('/sync/blockouts', (req, res) => {
  let result = store.blockouts || [];
  if (req.query.date)  result = result.filter(b => b.date  === req.query.date);
  if (req.query.email) result = result.filter(b => b.email === (req.query.email || '').toLowerCase());
  res.json(result);
});

// ── POST /sync/assignment/respond ────────────────────────────────────────────
app.post('/sync/assignment/respond', async (req, res) => {
  try {
    const { assignmentId, email, status } = req.body;
    if (!assignmentId || !email) return res.status(400).json({ error: 'assignmentId and email required' });
    if (!store.assignmentResponses) store.assignmentResponses = {};
    store.assignmentResponses[assignmentId] = {
      email: email.trim().toLowerCase(),
      status: status || 'pending',
      updatedAt: new Date().toISOString(),
    };
    await persist();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /sync/assignment/responses?serviceId= ────────────────────────────────
app.get('/sync/assignment/responses', (req, res) => {
  const serviceId = req.query.serviceId || '';
  const entries   = Object.entries(store.assignmentResponses || {})
    .map(([id, r]) => ({ assignmentId: id, ...r }));
  res.json(serviceId ? entries.filter(r => r.assignmentId.startsWith(serviceId + '_')) : entries);
});

// ── GET /sync/song-library ───────────────────────────────────────────────────
app.get('/sync/song-library', (req, res) => {
  let result = Object.values(store.songLibrary || {});
  if (req.query.since)  { const ts = new Date(req.query.since).getTime(); result = result.filter(s => new Date(s.updatedAt || 0).getTime() > ts); }
  if (req.query.songId) result = result.filter(s => s.id === req.query.songId);
  res.json(result);
});

// ── GET /sync/debug ──────────────────────────────────────────────────────────
app.get('/sync/debug', (req, res) => res.json({
  people: store.people, services: store.services, plans: store.plans,
}));

// ── GET /sync/status  (health check) ────────────────────────────────────────
app.get('/sync/status', (req, res) => res.json({
  ok: true, service: 'UltimateSync', version: '3.0.0',
  services: store.services.length,
  people:   store.people.length,
  plans:    Object.keys(store.plans).length,
}));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'UltimateSync', version: '3.0.0', db: pool ? 'postgres' : 'memory' }));

// ── Boot ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎵 Ultimate Sync Server v3.0`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   DB: PostgreSQL ✅`);
    console.log(`   Mode: ${process.env.NODE_ENV === 'production' ? '🔴 PRODUCTION' : '🟡 development'}\n`);
  });
}).catch(e => {
  console.error('❌ Failed to init DB:', e.message);
  process.exit(1);
});
