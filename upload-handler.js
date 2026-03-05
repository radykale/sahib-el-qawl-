const cloudinary = require('./cloudinary-config');
const fs = require('fs');

async function uploadToCloudinary(filePath, fileName) {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: 'video', // Cloudinary utilise 'video' pour l'audio
      public_id: fileName,
      folder: 'sahib-el-qawl',
      overwrite: true
    });
    // Supprimer le fichier local après upload
    fs.unlinkSync(filePath);
    return result.secure_url;
  } catch (err) {
    console.error('❌ Erreur Cloudinary:', err.message);
    throw err;
  }
}

module.exports = { uploadToCloudinary };
