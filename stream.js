const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

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
    this.jingleInterval = 3; // Jingle toutes les 3 pistes
  }

  addClient(res) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'X-Audiocast-Name': 'Radio Sahib El Qawl'
    });
    this.clients.push(res);
    console.log(`🎧 Nouvel auditeur connecté (${this.clients.length} total)`);
    res.on('close', () => {
      this.clients = this.clients.filter(c => c !== res);
      console.log(`👋 Auditeur déconnecté (${this.clients.length} restants)`);
    });
  }

  broadcast(chunk) {
    this.clients.forEach(client => {
      try { client.write(chunk); } catch(e) {
        this.clients = this.clients.filter(c => c !== client);
      }
    });
  }

  loadPlaylist(tracks, jingles) {
    this.playlist = tracks.filter(t => !t.isJingle);
    this.jingles = jingles || tracks.filter(t => t.isJingle);
    this.trackIndex = 0;
    this.trackCount = 0;
    console.log(`📋 Playlist chargée: ${this.playlist.length} pistes, ${this.jingles.length} jingles`);
  }

  async playNext() {
    if (!this.playlist.length) {
      console.log('⚠️ Playlist vide');
      setTimeout(() => this.playNext(), 5000);
      return;
    }

    // Jouer un jingle toutes les X pistes
    if (this.trackCount > 0 && this.trackCount % this.jingleInterval === 0 && this.jingles.length) {
      const jingle = this.jingles[Math.floor(Math.random() * this.jingles.length)];
      console.log(`🎺 Jingle: ${jingle.title}`);
      await this.playFile(jingle);
    }

    const track = this.playlist[this.trackIndex];
    this.trackIndex = (this.trackIndex + 1) % this.playlist.length;
    this.trackCount++;
    console.log(`🎵 En cours: ${track.title}`);
    this.currentTrack = track;
    this.emit('trackChange', track);
    await this.playFile(track);
    this.playNext();
  }

  playFile(track) {
    return new Promise((resolve) => {
      const filePath = path.join(__dirname, 'uploads', track.filename);
      if (!fs.existsSync(filePath)) {
        console.log(`❌ Fichier introuvable: ${track.filename}`);
        return resolve();
      }
      const stream = fs.createReadStream(filePath, { highWaterMark: 16384 });
      stream.on('data', chunk => this.broadcast(chunk));
      stream.on('end', resolve);
      stream.on('error', (err) => {
        console.log(`❌ Erreur lecture: ${err.message}`);
        resolve();
      });
    });
  }

  start(tracks, jingles) {
    if (this.playing) return;
    this.playing = true;
    this.loadPlaylist(tracks, jingles);
    this.playNext();
    console.log('🎙️ Streaming démarré!');
  }

  updatePlaylist(tracks, jingles) {
    this.playlist = tracks.filter(t => !t.isJingle);
    this.jingles = jingles || tracks.filter(t => t.isJingle);
    console.log(`🔄 Playlist mise à jour: ${this.playlist.length} pistes`);
  }

  getStatus() {
    return {
      playing: this.playing,
      currentTrack: this.currentTrack,
      listeners: this.clients.length,
      playlistSize: this.playlist.length
    };
  }
}

module.exports = new RadioStream();
