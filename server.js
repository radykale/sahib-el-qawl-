const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const app = express();
const http = require('http');
const server = http.createServer(app);

// ── Config ──────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// ── Data ─────────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {
    emission: { title: 'راديو صاحب القول', category: '' },
    tracks: [],
    playlists: [],
    schedule: {}
  };}
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Multer ───────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const name = Date.now() + '-' + file.originalname.replace(/\s/g, '_');
    cb(null, name);
  }
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  const allowed = ['.mp3', '.wav', '.ogg', '.m4a'];
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, allowed.includes(ext));
}});

// ── Middleware ───────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'sahib-el-qawl-secret', resave: false, saveUninitialized: false }));
app.use(express.static(__dirname + '/public'));
app.use('/uploads', express.static(UPLOADS_DIR));

function requireAuth(req, res, next) {
  if (req.session.admin) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// ── Scheduler ────────────────────────────────────────
let currentTrackIndex = 0;
let currentPlaylistTracks = [];

function getCurrentSchedule() {
  const data = loadData();
  const now = new Date();
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const day = days[now.getDay()];
  const hour = now.getHours();
  const schedule = data.schedule[day] || {};
  // Cherche la tranche horaire actuelle
  for (let h = hour; h >= 0; h--) {
    if (schedule[h]) return schedule[h];
  }
  return null;
}

function getPlaylistTracks(playlistId) {
  const data = loadData();
  const playlist = data.playlists.find(p => p.id == playlistId);
  if (!playlist) return [];
  return data.tracks.filter(t => playlist.trackIds.includes(t.id));
}

// Vérifie toutes les minutes si la playlist doit changer
cron.schedule('* * * * *', () => {
  const scheduleId = getCurrentSchedule();
  if (scheduleId) {
    const tracks = getPlaylistTracks(scheduleId);
    if (tracks.length) {
      currentPlaylistTracks = tracks;
      const data = loadData();
      const playlist = data.playlists.find(p => p.id == scheduleId);
      if (playlist) {
        data.emission.title = playlist.name;
        data.emission.category = playlist.category || '';
        saveData(data);
      }
    }
  }
});

// ── API Publique ──────────────────────────────────────
app.get('/api/emission', (req, res) => {
  const data = loadData();
  res.json(data.emission);
});

app.get('/api/tracks', (req, res) => {
  const data = loadData();
  res.json(data.tracks);
});

app.get('/api/playlists', (req, res) => {
  const data = loadData();
  res.json(data.playlists);
});

app.get('/api/schedule', (req, res) => {
  const data = loadData();
  res.json(data.schedule);
});

// ── Auth ─────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.admin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Mot de passe incorrect' });
  }
});
app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/admin/check', (req, res) => { res.json({ admin: !!req.session.admin }); });

// ── Admin: Emission ───────────────────────────────────
app.post('/api/admin/emission', requireAuth, (req, res) => {
  const data = loadData();
  data.emission = { ...data.emission, ...req.body, updatedAt: new Date().toISOString() };
  saveData(data);
  res.json({ success: true });
});

// ── Admin: Upload ─────────────────────────────────────
app.post('/api/admin/upload', requireAuth, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier invalide' });
  const data = loadData();
  const track = {
    id: Date.now(),
    filename: req.file.filename,
    originalName: req.file.originalname,
    category: req.body.category || 'عام',
    title: req.body.title || req.file.originalname,
    isJingle: req.body.isJingle === 'true',
    size: req.file.size,
    uploadedAt: new Date().toISOString()
  };
  data.tracks.push(track);
  saveData(data);
  res.json({ success: true, track });
});

app.delete('/api/admin/track/:id', requireAuth, (req, res) => {
  const data = loadData();
  const track = data.tracks.find(t => t.id == req.params.id);
  if (track) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, track.filename)); } catch(e) {}
    data.tracks = data.tracks.filter(t => t.id != req.params.id);
    saveData(data);
  }
  res.json({ success: true });
});

// ── Admin: Playlists ──────────────────────────────────
app.post('/api/admin/playlist', requireAuth, (req, res) => {
  const data = loadData();
  const playlist = {
    id: Date.now(),
    name: req.body.name,
    category: req.body.category || '',
    trackIds: req.body.trackIds || [],
    createdAt: new Date().toISOString()
  };
  data.playlists.push(playlist);
  saveData(data);
  res.json({ success: true, playlist });
});

app.put('/api/admin/playlist/:id', requireAuth, (req, res) => {
  const data = loadData();
  const idx = data.playlists.findIndex(p => p.id == req.params.id);
  if (idx !== -1) data.playlists[idx] = { ...data.playlists[idx], ...req.body };
  saveData(data);
  res.json({ success: true });
});

app.delete('/api/admin/playlist/:id', requireAuth, (req, res) => {
  const data = loadData();
  data.playlists = data.playlists.filter(p => p.id != req.params.id);
  saveData(data);
  res.json({ success: true });
});

// ── Admin: Schedule ───────────────────────────────────
app.post('/api/admin/schedule', requireAuth, (req, res) => {
  const { day, hour, playlistId } = req.body;
  const data = loadData();
  if (!data.schedule[day]) data.schedule[day] = {};
  data.schedule[day][hour] = playlistId;
  saveData(data);
  res.json({ success: true });
});

app.delete('/api/admin/schedule', requireAuth, (req, res) => {
  const { day, hour } = req.body;
  const data = loadData();
  if (data.schedule[day]) delete data.schedule[day][hour];
  saveData(data);
  res.json({ success: true });
});

// ── Stream ────────────────────────────────────────────
app.get('/stream', (req, res) => {
  res.status(200).send('Stream coming soon');
});

// ── Pages ─────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎙️ ================================`);
  console.log(`🎙️  راديو صاحب القول`);
  console.log(`🎙️  http://localhost:${PORT}`);
  console.log(`🎙️  Admin: http://localhost:${PORT}/admin`);
  console.log(`🎙️ ================================\n`);
});

// ── STREAMING ─────────────────────────────────────────
const radioStream = require('./stream');

// Démarrer le stream automatiquement
function startStream() {
  const data = loadData();
  const tracks = data.tracks.filter(t => !t.isJingle);
  const jingles = data.tracks.filter(t => t.isJingle);
  if (tracks.length) {
    radioStream.start(tracks, jingles);
  } else {
    console.log('⚠️ Aucune piste — en attente de fichiers audio');
    setTimeout(startStream, 30000);
  }
}
startStream();

// Route stream
app.get('/stream', (req, res) => {
  radioStream.addClient(res);
});

// Status stream
app.get('/api/stream/status', (req, res) => {
  res.json(radioStream.getStatus());
});

// Admin: mettre à jour le stream
app.post('/api/admin/stream/update', requireAuth, (req, res) => {
  const data = loadData();
  radioStream.updatePlaylist(
    data.tracks.filter(t => !t.isJingle),
    data.tracks.filter(t => t.isJingle)
  );
  res.json({ success: true });
});
