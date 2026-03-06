const mongoose = require('mongoose');

const trackSchema = new mongoose.Schema({
  id: Number,
  filename: String,
  url: String,
  originalName: String,
  category: String,
  title: String,
  isJingle: Boolean,
  size: Number,
  uploadedAt: String
});

const playlistSchema = new mongoose.Schema({
  id: Number,
  name: String,
  category: String,
  trackIds: [Number],
  createdAt: String
});

const emissionSchema = new mongoose.Schema({
  title: String,
  category: String,
  updatedAt: String
});

const scheduleSchema = new mongoose.Schema({
  day: String,
  hour: Number,
  playlistId: Number
});

const Track = mongoose.model('Track', trackSchema);
const Playlist = mongoose.model('Playlist', playlistSchema);
const Emission = mongoose.model('Emission', emissionSchema);
const Schedule = mongoose.model('Schedule', scheduleSchema);

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connecté!');
  } catch(err) {
    console.error('❌ MongoDB erreur:', err.message);
  }
}

module.exports = { connectDB, Track, Playlist, Emission, Schedule };
