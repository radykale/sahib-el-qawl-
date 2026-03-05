const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
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
    this.jingleInterval = 3;
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
    console.log(`🎧 Auditeur connecté (${this.clients.length} total)`);
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
    console.log(`📋 Playlist: ${this.playlist.length} pistes, ${this.jingles.length} jingles`);
  }

  async playNext() {
    if (!this.playlist.length) {
      console.log('⚠️ Playlist vide — en attente');
      setTimeout(() => this.playNext(), 10000);
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
      // Si URL Cloudinary
      if (track.url) {
        this.streamFromUrl(track.url, resolve);
      } else {
        // Fichier local
        const filePath = path.join(__dirname, 'uploads', track.filename);
        if (!fs.existsSync(filePath)) {
          console.log(`❌ Fichier introuvable: ${track.filename}`);
          return resolve();
        }
        const stream = fs.createReadStream(filePath, { highWaterMark: 16384 });
        stream.on('data', chunk => this.broadcast(chunk));
        stream.on('end', resolve);
        stream.on('error', () => resolve());
      }
    });
  }

  streamFromUrl(url, resolve) {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      response.on('data', chunk => this.broadcast(chunk));
      response.on('end', resolve);
      response.on('error', () => resolve());
    }).on('error', (err) => {
      console.log(`❌ Erreur stream URL: ${err.message}`);
      resolve();
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
    this.trackIndex = 0;
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
