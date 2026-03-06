const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const cloudinary = require('cloudinary').v2;
const app = express();
const http = require('http');
const server = http.createServer(app);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = path.join(__dirname, 'data.json');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { emission: { title: 'راديو صاحب القول', category: '' }, tracks: [], playlists: [], schedule: {} }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

async function uploadToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'video', folder: 'sahib-el-qawl', public_id: filename },
      (error, result) => { if (error) reject(error); else resolve(result.secure_url); }
    );
    stream.end(buffer);
  });
}

const upload = multer({ storage: multer.memoryStorage(), fileFilter: (req, file, cb) => {
  const allowed = ['.mp3', '.wav', '.ogg', '.m4a'];
  cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
}});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'sahib-el-qawl-secret', resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session.admin) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// ── Stream ────────────────────────────────────────────
const { EventEmitter } = require('events');
const https = require('https');

class RadioStream extends EventEmitter {
  constructor() {
    super();
    this.clients = [];
    this.currentTrack = null;
    this.playlist = [];
    this.trackIndex = 0;
    this.playing = false;
    this.jingles = [];
    this.trackCount = 0;
    this.jingleInterval = 3;
  }

  addClient(res) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache'
    });
    this.clients.push(res);
    console.log(`🎧 Auditeur connecté (${this.clients.length})`);
    res.on('close', () => { this.clients = this.clients.filter(c => c !== res); });
  }

  broadcast(chunk) {
    this.clients.forEach(client => {
      try { client.write(chunk); } catch(e) { this.clients = this.clients.filter(c => c !== client); }
    });
  }

  async playNext() {
    if (!this.playlist.length) {
      console.log('⚠️ Aucune piste — en attente de fichiers audio');
      setTimeout(() => this.playNext(), 30000);
      return;
    }
    if (this.trackCount > 0 && this.trackCount % this.jingleInterval === 0 && this.jingles.length) {
      const jingle = this.jingles[Math.floor(Math.random() * this.jingles.length)];
      console.log(`🎺 Jingle: ${jingle.title}`);
      await this.playTrack(jingle);
    }
    const track = this.playlist[this.trackIndex];
    this.trackIndex = (this.trackIndex + 1) % this.playlist.length;
    this.trackCount++;
    console.log(`🎵 En cours: ${track.title}`);
    this.currentTrack = track;
    this.emit('trackChange', track);
    await this.playTrack(track);
    this.playNext();
  }

  playTrack(track) {
    return new Promise((resolve) => {
      if (!track.url) return resolve();
      const protocol = track.url.startsWith('https') ? https : require('http');
      protocol.get(track.url, (response) => {
        response.on('data', chunk => this.broadcast(chunk));
        response.on('end', resolve);
        response.on('error', resolve);
      }).on('error', resolve);
    });
  }

  start(tracks, jingles) {
    if (this.playing) return;
    this.playing = true;
    this.playlist = tracks.filter(t => !t.isJingle);
    this.jingles = jingles || tracks.filter(t => t.isJingle);
    this.playNext();
    console.log('🎙️ Streaming démarré!');
  }

  updatePlaylist(tracks) {
    this.playlist = tracks.filter(t => !t.isJingle);
    this.jingles = tracks.filter(t => t.isJingle);
    this.trackIndex = 0;
  }

  getStatus() {
    return { playing: this.playing, currentTrack: this.currentTrack, listeners: this.clients.length };
  }
}

const radioStream = new RadioStream();

function startStream() {
  const data = loadData();
  const tracks = data.tracks.filter(t => t.url);
  if (tracks.length) {
    radioStream.start(tracks, tracks.filter(t => t.isJingle));
  } else {
    console.log('⚠️ Aucune piste — en attente de fichiers audio');
    setTimeout(startStream, 30000);
  }
}
startStream();

// ── API ───────────────────────────────────────────────
app.get('/api/emission', (req, res) => res.json(loadData().emission));
app.get('/api/tracks', (req, res) => res.json(loadData().tracks));
app.get('/api/playlists', (req, res) => res.json(loadData().playlists));
app.get('/api/schedule', (req, res) => res.json(loadData().schedule));
app.get('/api/stream/status', (req, res) => res.json(radioStream.getStatus()));
app.get('/stream', (req, res) => radioStream.addClient(res));

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) { req.session.admin = true; res.json({ success: true }); }
  else res.status(401).json({ error: 'Mot de passe incorrect' });
});
app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/admin/check', (req, res) => res.json({ admin: !!req.session.admin }));

app.post('/api/admin/emission', requireAuth, (req, res) => {
  const data = loadData();
  data.emission = { ...data.emission, ...req.body, updatedAt: new Date().toISOString() };
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/upload', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier invalide' });
  try {
    const url = await uploadToCloudinary(req.file.buffer, Date.now() + '-' + req.file.originalname);
    const data = loadData();
    const track = {
      id: Date.now(),
      filename: req.file.originalname,
      url,
      originalName: req.file.originalname,
      category: req.body.category || 'عام',
      title: req.body.title || req.file.originalname,
      isJingle: req.body.isJingle === 'true',
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };
    data.tracks.push(track);
    saveData(data);
    radioStream.updatePlaylist(data.tracks);
    if (!radioStream.playing) startStream();
    res.json({ success: true, track });
  } catch(err) {
    console.error('❌ Cloudinary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/track/:id', requireAuth, (req, res) => {
  const data = loadData();
  data.tracks = data.tracks.filter(t => t.id != req.params.id);
  saveData(data);
  radioStream.updatePlaylist(data.tracks);
  res.json({ success: true });
});

app.post('/api/admin/playlist', requireAuth, (req, res) => {
  const data = loadData();
  const playlist = { id: Date.now(), name: req.body.name, category: req.body.category || '', trackIds: req.body.trackIds || [], createdAt: new Date().toISOString() };
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

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎙️ ================================`);
  console.log(`🎙️  راديو صاحب القول`);
  console.log(`🎙️  http://localhost:${PORT}`);
  console.log(`🎙️  Admin: http://localhost:${PORT}/admin`);
  console.log(`🎙️ ================================\n`);
});
