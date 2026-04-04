const path = require("path");
const fs = require("fs").promises;
const http = require('http');
/**
 * Ultimate Ecosystem Sync Server v3
 * PostgreSQL persistence — Railway ready
 */

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

// ── WebSocket (MIDI bridge) — optional, graceful if ws not installed ──────────
let WebSocket, wss;
const wsClients = new Set();
try {
  WebSocket = require('ws');
} catch { console.log('[MIDI] ws package not found — run: npm install ws  in UltimateSyncServer/'); }

const PORT = process.env.PORT || 8099;
const DB_URL = process.env.DATABASE_URL || '';
const pool = DB_URL ? new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
}) : null;

// ── File-based persistence (fallback when no DATABASE_URL) ───────────────────
const STORE_FILE = path.join(__dirname, 'store.json');

async function loadFromFile() {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveToFile() {
  if (pool) return; // using postgres — skip file
  try { await fs.writeFile(STORE_FILE, JSON.stringify(store)); } catch {}
}

// ── In-memory store (warm cache) ────────────────────────────────────────────
let store = {
  services: [], plans: {}, people: [], messages: [],
  grants: {}, proposals: [], blockouts: [],
  assignmentResponses: {}, songLibrary: {},
};

// ── PostgreSQL persistence ───────────────────────────────────────────────────
async function initDB() {
  if (!pool) {
    // Try loading from file first
    const saved = await loadFromFile();
    if (saved) {
      store = { ...store, ...saved };
      if (!store.grants)              store.grants              = {};
      if (!store.proposals)           store.proposals           = [];
      if (!store.blockouts)           store.blockouts           = [];
      if (!store.assignmentResponses) store.assignmentResponses = {};
      if (!store.songLibrary)         store.songLibrary         = {};
      console.log(`[boot] Loaded from file: ${store.services.length} services, ${store.people.length} people, ${Object.keys(store.songLibrary).length} songs`);
    } else {
      console.log('[boot] No DATABASE_URL — fresh in-memory store');
    }
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
  if (!pool) { await saveToFile(); return; }
  await pool.query(
    `INSERT INTO sync_store (id, data) VALUES ('main', $1)
     ON CONFLICT (id) DO UPDATE SET data = $1`,
    [store]
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Collapse consecutive duplicate letters: "jefferson" → "jeferson"
function normName(s) { return s.replace(/(.)\1+/g, '$1'); }

function findPerson(email, name) {
  if (!email && !name) return null;
  const q  = (email || '').trim().toLowerCase();
  const qn = (name  || '').trim().toLowerCase();
  const namePrefix = q ? q.split('@')[0].replace(/[._\d]/g, ' ').trim() : '';
  return store.people.find(p => {
    const pe = (p.email || '').toLowerCase();
    const pn = (p.name  || '').toLowerCase();
    if (q && pe === q) return true;
    if (q && pn === q) return true;
    if (namePrefix.length > 3 && pn === namePrefix) return true;
    if (qn) {
      if (pn === qn) return true;
      // Last name + normalized first name: "Jeferson Nascimento" ↔ "Jefferson Nascimento"
      // normName collapses double letters so "jefferson"→"jeferson" === "jeferson"
      const qParts = qn.split(/\s+/);
      const pParts = pn.split(/\s+/);
      if (qParts.length >= 2 && pParts.length >= 2) {
        const qLast = qParts[qParts.length - 1];
        const pLast = pParts[pParts.length - 1];
        if (qLast.length >= 4 && qLast === pLast) {
          // Last names match — also check first name via dedup-normalization
          if (normName(qParts[0]) === normName(pParts[0])) return true;
        }
      }
    }
    return false;
  }) || null;
}

// ── Express app ──────────────────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);
app.use(express.json());
app.use(cors());

// ── Static audio assets (PADS + Guides) ──────────────────────────────────────
app.use('/pads',   express.static('/Users/studio/Downloads/PADS',            { setHeaders: (res) => res.set('Access-Control-Allow-Origin', '*') }));
app.use('/guides', express.static('/Users/studio/Downloads/Guias: Guides',   { setHeaders: (res) => res.set('Access-Control-Allow-Origin', '*') }));

// ── WebSocket server for real-time MIDI bridge ────────────────────────────────
if (WebSocket) {
  wss = new WebSocket.Server({ server: httpServer, path: '/midi/ws' });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close',   () => wsClients.delete(ws));
    ws.on('error',   () => wsClients.delete(ws));
  });
}
function broadcastMidi(msg) {
  if (!wsClients.size) return;
  const data = JSON.stringify(msg);
  wsClients.forEach(ws => { try { if (ws.readyState === 1) ws.send(data); } catch {} });
}

// ── POST /midi/command ────────────────────────────────────────────────────────
// Receives MIDI-translated commands from Electron desktop bridge,
// broadcasts to all connected Playback WebSocket clients.
// Body: { type: 'MIDI_NEXT'|'MIDI_PREV'|'MIDI_PLAY'|'MIDI_STOP'|'MIDI_GOTO_SONG'|
//               'MIDI_SECTION'|'MIDI_FADER'|'MIDI_PAN'|'MIDI_SONG_POSITION', ... }
app.post('/midi/command', (req, res) => {
  const cmd = req.body;
  if (!cmd || !cmd.type) return res.status(400).json({ error: 'type required' });
  broadcastMidi(cmd);
  res.json({ ok: true, clients: wsClients.size });
});

// ── POST /sync/publish ───────────────────────────────────────────────────────
app.post('/sync/publish', async (req, res) => {
  try {
    const body = req.body;
    console.log(`[publish-in] services=${Array.isArray(body.services)?body.services.length:'?'} people=${Array.isArray(body.people)?body.people.length:'?'} plans=${Object.keys(body.plans||{}).length}`);
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
    // UM sends { serviceId, plan } (singular) — store it so /sync/assignments can read team
    if (body.serviceId && body.plan) {
      store.plans[body.serviceId] = body.plan;
    }
    if (body.vocalAssignments) {
      if (!store.vocalAssignments) store.vocalAssignments = {};
      // Store per-serviceId so Playback can look up lib.vocalAssignments[serviceId]
      if (body.serviceId) {
        store.vocalAssignments[body.serviceId] = body.vocalAssignments;
      } else {
        Object.assign(store.vocalAssignments, body.vocalAssignments);
      }
    }
    await persist();
    console.log(`[publish] ${store.services.length} services, ${store.people.length} people`);
    res.json({ ok: true, services: store.services.length, people: store.people.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /sync/song/patch ─────────────────────────────────────────────────────
// Directly patch a single song field — used by ContentEditor admin Apply
// Body: { serviceId, songId, field: 'lyrics'|'chordChart'|'instrumentNotes', value, instrument? }
app.post('/sync/song/patch', async (req, res) => {
  try {
    const { serviceId, songId, field, value, instrument } = req.body;
    if (!serviceId || !songId || !field) return res.status(400).json({ error: 'serviceId, songId and field are required' });
    const plan = store.plans[serviceId];
    if (!plan) return res.status(404).json({ error: 'Plan not found — publish from Musician first' });
    const song = (plan.songs || []).find(s => s.id === songId);
    if (!song) return res.status(404).json({ error: 'Song not found in plan' });
    if (field === 'lyrics') {
      song.lyrics    = value || '';
      song.hasLyrics = !!(value && value.trim());
    } else if (field === 'chordChart') {
      song.chordChart = value || '';
      song.chordSheet = value || '';
    } else if (field === 'instrumentNotes' && instrument) {
      if (!song.instrumentNotes) song.instrumentNotes = {};
      song.instrumentNotes[instrument] = value || '';
    } else {
      return res.status(400).json({ error: `Unknown field "${field}"` });
    }
    await persist();
    console.log(`[song/patch] svc=${serviceId} song=${songId} field=${field}${instrument?' instr='+instrument:''}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /sync/assignments?email=&name= ───────────────────────────────────────
app.get('/sync/assignments', (req, res) => {
  const email  = req.query.email || '';
  const name   = req.query.name  || '';
  const person = findPerson(email, name);
  const assignments = [];

  // Build a set of all IDs that could represent this person across apps.
  // UM and Playback may have different UUIDs for the same person — match by
  // email (exact) or normalized name as fallback so cross-app sync works.
  function teamEntryMatchesPerson(t) {
    if (!person) return false;
    if (t.personId === person.id) return true;
    // Email match — team entry now carries email since the UM fix
    const te = (t.email || '').trim().toLowerCase();
    const pe = (person.email || '').trim().toLowerCase();
    if (te && pe && te === pe) return true;
    // Name match (normalized) — last resort
    const tn = (t.name || '').trim().toLowerCase();
    const pn = (person.name || '').trim().toLowerCase();
    if (tn && pn && normName(tn) === normName(pn)) return true;
    return false;
  }

  // Also match directly by the query email/name against team entries,
  // even if store.people doesn't have this person yet (UM may not have pushed people)
  const qEmail = email.trim().toLowerCase();
  const qName  = name.trim().toLowerCase();
  function teamEntryMatchesQuery(t) {
    const te = (t.email || '').trim().toLowerCase();
    const tn = (t.name  || '').trim().toLowerCase();
    if (qEmail && te && te === qEmail) return true;
    if (qName  && tn && normName(tn) === normName(qName)) return true;
    return false;
  }

  if (email || name) {
    const serviceMap = {};
    for (const svc of store.services) serviceMap[svc.id] = svc;
    for (const planId of Object.keys(store.plans)) {
      if (!serviceMap[planId])
        serviceMap[planId] = { id: planId, name: 'Service', date: '', time: '', serviceType: 'standard' };
    }
    for (const svc of Object.values(serviceMap)) {
      const plan    = store.plans[svc.id] || {};
      const team    = plan.team || [];
      const matches = team.filter(t => teamEntryMatchesPerson(t) || teamEntryMatchesQuery(t));
      if (matches.length > 0) {
        // Compute explicit service_end_at = service date + time + 2 hours grace
        let service_end_at = null;
        const rawDate = svc.date || svc.serviceDate || '';
        const rawTime = svc.time || svc.startTime || '';
        if (rawDate) {
          // Append T00:00:00 so JS parses as local time, not UTC midnight
          const localStr = String(rawDate).includes('T') ? rawDate : `${rawDate}T00:00:00`;
          const dt = new Date(localStr);
          if (Number.isFinite(dt.getTime())) {
            const m = String(rawTime).match(/(\d{1,2}):(\d{2})/);
            if (m) dt.setHours(Number(m[1]), Number(m[2]), 0, 0);
            else   dt.setHours(23, 59, 59, 999);
            service_end_at = dt.toISOString();
          }
        }
        const personKey = person?.id || qEmail || qName || 'unknown';
        assignments.push({
          id:             `${svc.id}_${personKey}`,
          service_id:     svc.id,
          service_name:   svc.name || svc.title || 'Service',
          service_date:   svc.date || svc.serviceDate || '',
          service_time:   svc.time || svc.startTime || '',
          service_type:   svc.serviceType || 'standard',
          service_end_at,
          role:           matches[0].role,
          roles:          matches.map(m => m.role),
          notes:          plan.notes || '',
          status:         'pending',
        });
      }
    }
  }
  res.json(assignments);
});

// ── POST /sync/heartbeat — member check-in ───────────────────────────────────
// Called by every Playback device on HomeScreen load.
// Body: { serviceId, email, name, role }
app.post('/sync/heartbeat', async (req, res) => {
  const { serviceId, email, name, role } = req.body || {};
  if (!serviceId || !email) return res.status(400).json({ error: 'serviceId and email required' });
  if (!store.heartbeats) store.heartbeats = {};
  if (!store.heartbeats[serviceId]) store.heartbeats[serviceId] = {};
  store.heartbeats[serviceId][email.toLowerCase().trim()] = {
    name: name || email,
    role: role || '',
    lastSeen: new Date().toISOString(),
  };
  await persist();
  res.json({ ok: true });
});

// ── GET /sync/team-pulse?serviceId= — worship leader team readiness ───────────
// Returns every member assigned to the service with their last heartbeat time.
// Members in plan.team who haven't sent a heartbeat are included as 'not seen'.
app.get('/sync/team-pulse', (req, res) => {
  const serviceId = req.query.serviceId || '';
  const plan      = store.plans[serviceId] || {};
  const team      = plan.team || [];
  const beats     = (store.heartbeats || {})[serviceId] || {};

  // Start with plan.team so even members who haven't opened the app are listed
  const memberMap = {};
  for (const t of team) {
    const key = (t.email || t.name || t.personId || '').toLowerCase().trim();
    if (!key) continue;
    memberMap[key] = {
      name:     t.name || t.email || key,
      role:     t.role || '',
      lastSeen: null,
    };
  }
  // Overlay actual heartbeat times
  for (const [emailKey, beat] of Object.entries(beats)) {
    if (memberMap[emailKey]) {
      memberMap[emailKey].lastSeen = beat.lastSeen;
      if (beat.role) memberMap[emailKey].role = beat.role;
    } else {
      // Member checked in but wasn't in plan.team — still show them
      memberMap[emailKey] = {
        name:     beat.name,
        role:     beat.role,
        lastSeen: beat.lastSeen,
      };
    }
  }

  const result = Object.values(memberMap).sort((a, b) => {
    // Active/synced first, then by name
    const sa = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
    const sb = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
    return sb - sa;
  });

  res.json(result);
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
    // Accept both formats:
    //   Old: { assignmentId, email, status }
    //   Playback: { serviceId, personId (= email), response, role }
    let { assignmentId, email, status, serviceId, personId, response, role } = req.body;
    email  = (email  || personId || '').trim().toLowerCase();
    status = status  || response || 'pending';
    if (!email) return res.status(400).json({ error: 'email or personId required' });
    if (!assignmentId && serviceId) assignmentId = `${serviceId}_${email}`;
    if (!assignmentId) return res.status(400).json({ error: 'assignmentId or serviceId required' });

    if (!store.assignmentResponses) store.assignmentResponses = {};
    store.assignmentResponses[assignmentId] = {
      email, status, updatedAt: new Date().toISOString(),
    };

    // Also write status directly into the plan's team record so library-pull reflects it
    const personName = req.body.name || req.body.personName || email;
    let serviceName = serviceId || '';
    if (serviceId && store.plans && store.plans[serviceId]) {
      const plan = store.plans[serviceId];
      serviceName = plan.title || plan.name || serviceId;
      if (Array.isArray(plan.team)) {
        plan.team = plan.team.map(tm => {
          const tmEmail = (tm.email || tm.personId || '').toLowerCase();
          if (tmEmail === email && (!role || tm.role === role)) {
            return { ...tm, status };
          }
          return tm;
        });
        store.plans[serviceId] = plan;
      }
    }

    // Auto-create notification message to admin
    const statusEmoji  = status === 'accepted' ? '✅' : status === 'declined' ? '❌' : '⏳';
    const declineReason = req.body.declineReason || req.body.reason || '';
    let msgBody = `${statusEmoji} ${personName} ${status === 'accepted' ? 'accepted' : status === 'declined' ? 'declined' : 'responded to'} the assignment`;
    if (role) msgBody += ` (${role})`;
    msgBody += ` for "${serviceName}".`;
    if (declineReason) msgBody += `\n\n💬 Reason: ${declineReason}`;
    store.messages = store.messages || [];
    store.messages.unshift({
      id:         `msg_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
      from_email: email,
      from_name:  personName,
      subject:    `${statusEmoji} Assignment ${status}: ${personName}`,
      message:    msgBody,
      to:         'admin',
      timestamp:  new Date().toISOString(),
      read:       false,
      replies:    [],
      isSystemMsg: true,
      metadata:   { serviceId, status, role, personEmail: email },
    });

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

// ── POST /sync/library-push — full device library → server ───────────────────
// Body: { songs, people, services, plans, vocalAssignments, blockouts,
//         replacePeopleSnapshot, replaceServicesSnapshot, replacePlansSnapshot,
//         replaceVocalAssignmentsSnapshot }
// When a replace* flag is true the server REPLACES the entire collection instead
// of merging — this is how admin deletes are honoured permanently.
app.post('/sync/library-push', async (req, res) => {
  const {
    songs = [], people = [], services = [], plans = {}, vocalAssignments = {}, blockouts = [],
    replacePeopleSnapshot, replaceServicesSnapshot, replacePlansSnapshot, replaceVocalAssignmentsSnapshot,
  } = req.body || {};

  // Songs — always merge (no delete semantics for songs yet)
  for (const song of songs) {
    if (song && song.id) store.songLibrary[song.id] = { ...song, updatedAt: new Date().toISOString() };
  }

  // People — replace entire list when flag is set (honours admin deletes)
  if (replacePeopleSnapshot) {
    store.people = people.filter(p => p && p.id);
  } else {
    for (const person of people) {
      if (!person || !person.id) continue;
      const idx = store.people.findIndex(p => p.id === person.id);
      if (idx >= 0) store.people[idx] = person; else store.people.push(person);
    }
  }

  // Services — replace or merge
  if (replaceServicesSnapshot) {
    store.services = services.filter(s => s && s.id);
  } else {
    for (const svc of services) {
      if (!svc || !svc.id) continue;
      const idx = store.services.findIndex(s => s.id === svc.id);
      if (idx >= 0) store.services[idx] = svc; else store.services.push(svc);
    }
  }

  // Plans — replace or merge
  if (replacePlansSnapshot) {
    if (plans && typeof plans === 'object') store.plans = plans;
  } else {
    if (plans && typeof plans === 'object') Object.assign(store.plans, plans);
  }

  // Vocal assignments — replace or merge
  if (!store.vocalAssignments) store.vocalAssignments = {};
  if (replaceVocalAssignmentsSnapshot) {
    if (vocalAssignments && typeof vocalAssignments === 'object') store.vocalAssignments = vocalAssignments;
  } else if (vocalAssignments && typeof vocalAssignments === 'object') {
    Object.assign(store.vocalAssignments, vocalAssignments);
  }
  // Merge blockouts (avoid duplicates by email+date)
  if (!store.blockouts) store.blockouts = [];
  for (const b of blockouts) {
    if (!b || !b.email || !b.date) continue;
    const exists = store.blockouts.find(x => x.email === b.email && x.date === b.date);
    if (!exists) store.blockouts.push(b);
  }
  await persist();
  console.log(`[library-push] songs=${Object.keys(store.songLibrary).length} people=${store.people.length} services=${store.services.length} plans=${Object.keys(store.plans).length}`);
  res.json({ ok: true, songs: Object.keys(store.songLibrary).length, people: store.people.length, services: store.services.length, plans: Object.keys(store.plans).length });
});

// ── GET /sync/library-pull — server → device ─────────────────────────────────
app.get('/sync/library-pull', (req, res) => {
  res.json({
    songs:             Object.values(store.songLibrary || {}),
    people:            store.people || [],
    services:          store.services || [],
    plans:             store.plans || {},
    vocalAssignments:  store.vocalAssignments || {},
    blockouts:         store.blockouts || [],
  });
});

// ── GET /sync/debug ──────────────────────────────────────────────────────────
// Returns full store so ContentEditor admin Apply can read → patch → republish
app.get('/sync/debug', (req, res) => res.json({
  services: store.services,
  people:   store.people,
  plans:    store.plans,
  messages: store.messages.length,
}));

// ── POST /sync/stems/zip ─────────────────────────────────────────────────────
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
app.post("/sync/stems/zip", upload.single("zip"), async (req, res) => {
  try {
    const { songId, title, artist } = req.body;
    if (!req.file) return res.status(400).json({ error: "No ZIP file uploaded" });
    
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(req.file.buffer);
    const files = Object.keys(zip.files).filter(name => 
      !zip.files[name].dir &&
      /\.(wav|mp3|flac|aiff)$/i.test(name)
    );
    
    const stemsDir = path.join(__dirname, "uploads", "stems", songId || `song-${Date.now()}`);
    await fs.mkdir(stemsDir, { recursive: true });
    
    const STEM_PATTERNS = {
      vocals: /(vox|vocals|vocal|lead|bv)/i,
      drums: /(drums|drum|kick|snare|hat|perc)/i,
      bass: /(bass|bassline|sub|lowend)/i,
      keys: /(keys|keyboard|piano|synth|organ)/i,
      guitars: /(guitar|guitars|electric|acoustic)/i,
      other: /(other|misc|fx|effects)/i,
    };
    
    function detectStemType(filename) {
      const name = filename.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const [stem, pattern] of Object.entries(STEM_PATTERNS)) {
        if (pattern.test(name)) return stem.toUpperCase();
      }
      return "OTHER";
    }
    
    const stems = [];
    for (const filename of files) {
      const stemType = detectStemType(filename);
      const clean = path.basename(filename).replace(/[^a-zA-Z0-9]/g, "_");
      const ext = path.extname(filename);
      const localPath = path.join(stemsDir, `${stemType}_${clean}${ext}`);
      
      const buffer = await zip.files[filename].async("nodebuffer");
      await fs.writeFile(localPath, buffer);
      
      stems.push({
        type: stemType,
        name: path.basename(filename, ext),
        url: `/uploads/stems/${path.basename(stemsDir)}/${path.basename(localPath)}`,
        localPath,
      });
    }
    
    res.status(200).json({
      id: songId || path.basename(stemsDir),
      title: title || "ZIP Stems Import",
      artist: artist || "Unknown",
      status: "COMPLETED",
      result: { stems, sections: [], chords: [] },
    });
  } catch (err) {
    console.error("[ZIP_ERROR]", err);
    res.status(500).json({ error: "Failed to process ZIP", details: err.message });
  }
});

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
  httpServer.listen(PORT, () => {
    console.log(`\n🎵 Ultimate Sync Server v3.0`);
    console.log(`   http://localhost:${PORT}`);
    if (WebSocket) console.log(`   ws://localhost:${PORT}/midi/ws  ← MIDI bridge`);
    console.log(`   DB: ${pool ? 'PostgreSQL ✅' : 'in-memory'}`);
    console.log(`   Mode: ${process.env.NODE_ENV === 'production' ? '🔴 PRODUCTION' : '🟡 development'}\n`);
  });
}).catch(e => {
  console.error('❌ Failed to init DB:', e.message);
  process.exit(1);
});
