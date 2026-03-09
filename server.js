const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { connectDB, Track, Playlist, Emission, Program } = require('./db');
const MongoStore = require('connect-mongo').default || require('connect-mongo');
const app = express();
const http = require('http');
const server = http.createServer(app);
const https = require('https');
const { EventEmitter } = require('events');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

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
app.use(session({ 
  secret: 'sahib-el-qawl-secret', 
  resave: false, 
  saveUninitialized: false,
  store: MongoStore.create({ 
    mongoUrl: process.env.MONGODB_URI,
    ttl: 60 * 60 * 24 * 7
  }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session.admin) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// ── Stream ────────────────────────────────────────────
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

  async fetchTrack(track) {
    return new Promise((resolve, reject) => {
      if (!track || !track.url) return resolve(Buffer.alloc(0));
      const protocol = track.url.startsWith('https') ? https : require('http');
      const chunks = [];
      protocol.get(track.url, (response) => {
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    });
  }

  async playBuffer(buffer) {
    return new Promise((resolve) => {
      const BITRATE = 128 * 1024 / 8;
      const CHUNK_SIZE = 16384;
      const INTERVAL = (CHUNK_SIZE / BITRATE) * 1000;
      let offset = 0;
      const tick = () => {
        if (offset + CHUNK_SIZE <= buffer.length) {
          this.broadcast(buffer.slice(offset, offset + CHUNK_SIZE));
          offset += CHUNK_SIZE;
          setTimeout(tick, INTERVAL);
        } else {
          if (offset < buffer.length) this.broadcast(buffer.slice(offset));
          resolve();
        }
      };
      tick();
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
    setImmediate(() => this.playNext());
  }

  playTrack(track) {
    return new Promise((resolve) => {
      if (!track.url) return resolve();
      const protocol = track.url.startsWith('https') ? https : require('http');
      protocol.get(track.url, (response) => {
        const BITRATE = 128 * 1024 / 8;
        const CHUNK_SIZE = 16384;
        const INTERVAL = (CHUNK_SIZE / BITRATE) * 1000;
        response.on('data', chunk => this.broadcast(chunk));
        response.on('end', resolve);
        response.on('error', resolve);
      }).on('error', resolve);
    });
  }

  start(tracks) {
    if (this.playing) return;
    this.playing = true;
    this.playlist = tracks.filter(t => !t.isJingle);
    this.jingles = tracks.filter(t => t.isJingle);
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

async function startStream() {
  const tracks = await Track.find({ url: { $exists: true } });
  if (tracks.length) {
    radioStream.start(tracks);
  } else {
    console.log('⚠️ Aucune piste — en attente de fichiers audio');
    setTimeout(startStream, 30000);
  }
}

// ── API ───────────────────────────────────────────────
app.get('/api/emission', async (req, res) => {
  const emission = await Emission.findOne() || { title: 'راديو صاحب القول', category: '' };
  res.json(emission);
});

app.get('/api/tracks', async (req, res) => {
  const tracks = await Track.find();
  res.json(tracks);
});

app.get('/api/playlists', async (req, res) => {
  const playlists = await Playlist.find();
  res.json(playlists);
});

app.get('/api/schedule', async (req, res) => {
  const programs = await Program.find({ active: true });
  res.json(programs);
});

app.post('/api/admin/program', requireAuth, async (req, res) => {
  const program = await Program.create({
    id: Date.now(),
    name: req.body.name,
    playlistId: req.body.playlistId,
    startTime: req.body.startTime,
    endTime: req.body.endTime,
    repeat: req.body.repeat || 'daily',
    days: req.body.days || [],
    active: true,
    createdAt: new Date().toISOString()
  });
  res.json({ success: true, program });
});

app.put('/api/admin/program/:id', requireAuth, async (req, res) => {
  await Program.findOneAndUpdate({ id: parseInt(req.params.id) }, req.body);
  res.json({ success: true });
});

app.delete('/api/admin/program/:id', requireAuth, async (req, res) => {
  await Program.deleteOne({ id: parseInt(req.params.id) });
  res.json({ success: true });
});

app.get('/api/stream/status', (req, res) => res.json(radioStream.getStatus()));
app.get('/stream', (req, res) => radioStream.addClient(res));

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) { req.session.admin = true; res.json({ success: true }); }
  else res.status(401).json({ error: 'Mot de passe incorrect' });
});
app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/admin/check', (req, res) => res.json({ admin: !!req.session.admin }));

app.post('/api/admin/emission', requireAuth, async (req, res) => {
  await Emission.findOneAndUpdate({}, { ...req.body, updatedAt: new Date().toISOString() }, { upsert: true });
  res.json({ success: true });
});

app.post('/api/admin/upload', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier invalide' });
  try {
    const safeName = req.file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    const url = await uploadToCloudinary(req.file.buffer, Date.now() + '-' + safeName);
    const track = await Track.create({
      id: Date.now(),
      filename: req.file.originalname,
      url,
      originalName: req.file.originalname,
      category: req.body.category || 'عام',
      title: req.body.title || req.file.originalname,
      isJingle: req.body.isJingle === 'true',
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    });
    const allTracks = await Track.find();
    radioStream.updatePlaylist(allTracks);
    if (!radioStream.playing) startStream();
    res.json({ success: true, track });
  } catch(err) {
    console.error('❌ Erreur upload:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/track/:id', requireAuth, async (req, res) => {
  await Track.deleteOne({ id: req.params.id });
  const tracks = await Track.find();
  radioStream.updatePlaylist(tracks);
  res.json({ success: true });
});

app.post('/api/admin/playlist', requireAuth, async (req, res) => {
  const playlist = await Playlist.create({
    id: Date.now(),
    name: req.body.name,
    category: req.body.category || '',
    trackIds: req.body.trackIds || [],
    createdAt: new Date().toISOString()
  });
  res.json({ success: true, playlist });
});

app.put('/api/admin/playlist/:id', requireAuth, async (req, res) => {
  await Playlist.findOneAndUpdate({ $or: [{id: parseInt(req.params.id)}, {_id: req.params.id}] }, req.body);
  res.json({ success: true });
});

app.delete('/api/admin/playlist/:id', requireAuth, async (req, res) => {
  await Playlist.deleteOne({ $or: [{id: parseInt(req.params.id)}, {_id: req.params.id}] });
  res.json({ success: true });
});

app.post('/api/admin/schedule', requireAuth, async (req, res) => {
  const { day, hour, playlistId } = req.body;
  await Schedule.findOneAndUpdate({ day, hour }, { day, hour, playlistId }, { upsert: true });
  res.json({ success: true });
});

app.delete('/api/admin/schedule', requireAuth, async (req, res) => {
  const { day, hour } = req.body;
  await Schedule.deleteOne({ day, hour });
  res.json({ success: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

const PORT = process.env.PORT || 3000;

// ── Scheduler ─────────────────────────────────────────
async function checkSchedule() {
  const now = new Date();
  // Utiliser l'heure locale du serveur (UTC+1 Paris)
  const offset = 1; // UTC+1
  const local = new Date(now.getTime() + offset * 60 * 60 * 1000);
  const currentTime = String(local.getUTCHours()).padStart(2,'0') + ':' + String(local.getUTCMinutes()).padStart(2,'0');
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const currentDay = days[local.getUTCDay()];
  console.log('⏰ Vérification schedule:', currentTime);

  const programs = await Program.find({ active: true });
  for (const prog of programs) {
    if (prog.startTime !== currentTime) continue;
    if (prog.repeat === 'daily' || 
        (prog.repeat === 'weekly' && prog.days.includes(currentDay)) ||
        prog.repeat === 'once') {
      const playlist = await Playlist.findOne({ $or: [{id: prog.playlistId}, {_id: prog.playlistId}] });
      if (!playlist) continue;
      const trackIds = playlist.trackIds;
      const tracks = await Track.find({ id: { $in: trackIds } });
      if (tracks.length) {
        console.log(`📅 Programme: ${prog.name} → ${playlist.name}`);
        radioStream.updatePlaylist(tracks);
        if (!radioStream.playing) radioStream.start(tracks);
      }
      if (prog.repeat === 'once') {
        await Program.findOneAndUpdate({ id: prog.id }, { active: false });
      }
    }
  }
}
setInterval(checkSchedule, 60000);

connectDB().then(() => {
  startStream();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎙️ ================================`);
    console.log(`🎙️  راديو صاحب القول`);
    console.log(`🎙️  http://localhost:${PORT}`);
    console.log(`🎙️  Admin: http://localhost:${PORT}/admin`);
    console.log(`🎙️ ================================\n`);
  });
});
