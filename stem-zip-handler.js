/**
 * Stem ZIP Handler for UltimateSyncServer
 * Handles ZIP file uploads, extracts stems, auto-detects types
 */
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Stem type detection patterns
const STEM_PATTERNS = {
  vocals: /(vox|vocals|vocal|lead|bv|background)/i,
  drums: /(drums|drum|kick|snare|hat|hihat|perc|percussion)/i,
  bass: /(bass|bassline|sub|lowend|bass.?guitar)/i,
  keys: /(keys|keyboard|piano|synth|organ|pad|keyboard.?synth)/i,
  guitars: /(guitar|guitars|electric|acoustic|gtr|lead.?guitar)/i,
  other: /(other|misc|fx|effects|ambient|strings|horns)/i,
};

// Audio file extensions
const AUDIO_EXTS = ['.wav', '.mp3', '.flac', '.aiff', '.m4a', '.ogg'];

/**
 * Detect stem type from filename
 */
function detectStemType(filename) {
  const name = filename.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  for (const [stem, pattern] of Object.entries(STEM_PATTERNS)) {
    if (pattern.test(name)) return stem.toUpperCase();
  }
  
  // Fallback: check if it's in a folder named after a stem
  const parts = filename.split('/');
  if (parts.length > 1) {
    const folder = parts[parts.length - 2].toLowerCase();
    for (const [stem, pattern] of Object.entries(STEM_PATTERNS)) {
      if (pattern.test(folder)) return stem.toUpperCase();
    }
  }
  
  return 'OTHER';
}

/**
 * Check if file is audio
 */
function isAudioFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return AUDIO_EXTS.includes(ext);
}

/**
 * Process ZIP file and extract stems
 */
async function processZipStems(zipBuffer, songId) {
  console.log(`[ZIP] Processing ZIP for song: ${songId}`);
  
  const zip = await JSZip.loadAsync(zipBuffer);
  const files = Object.keys(zip.files).filter(name => 
    !zip.files[name].dir && isAudioFile(name)
  );
  
  console.log(`[ZIP] Found ${files.length} audio files`);
  
  const stemsDir = path.join(process.cwd(), 'uploads', 'stems', songId);
  await fs.mkdir(stemsDir, { recursive: true });
  
  const stemsResult = {
    stems: [],
    detectedTypes: new Set(),
    sections: [],
    chords: [],
    analysis: {
      totalFiles: files.length,
      detectedStems: {},
    },
  };
  
  for (const filename of files) {
    console.log(`[ZIP] Processing: ${filename}`);
    
    const fileData = await zip.files[filename].async('nodebuffer');
    const stemType = detectStemType(filename);
    const cleanName = path.basename(filename).replace(/[^a-zA-Z0-9]/g, '_');
    const ext = path.extname(filename);
    const localPath = path.join(stemsDir, `${stemType}_${cleanName}${ext}`);
    
    await fs.writeFile(localPath, fileData);
    
    const stat = await fs.stat(localPath);
    stemsResult.stems.push({
      type: stemType,
      name: path.basename(filename, ext),
      localPath,
      url: `/uploads/stems/${songId}/${path.basename(localPath)}`,
      size: stat.size,
      format: ext.slice(1),
    });
    
    stemsResult.detectedTypes.add(stemType);
    stemsResult.analysis.detectedStems[stemType] = (stemsResult.analysis.detectedStems[stemType] || 0) + 1;
  }
  
  console.log('[ZIP] Stems processed:', Object.entries(stemsResult.analysis.detectedStems));
  
  return stemsResult;
}

/**
 * Express middleware for ZIP upload
 */
async function handleZipUpload(req, res) {
  try {
    const { songId, title, artist } = req.body;
    
    if (!req.file && !req.files) {
      return res.status(400).json({ error: 'No ZIP file uploaded' });
    }
    
    const file = req.file || req.files?.[0];
    const song_id = songId || `song-${crypto.randomBytes(4).toString('hex')}`;
    const song_title = title || 'ZIP Stems Import';
    const song_artist = artist || 'Unknown';
    
    console.log(`[ZIP_UPLOAD] Song: ${song_title} by ${song_artist}, ID: ${song_id}`);
    
    const result = await processZipStems(file.buffer, song_id);
    
    res.status(200).json({
      id: song_id,
      title: song_title,
      artist: song_artist,
      status: 'COMPLETED',
      result: {
        success: true,
        stems_extracted: result.stems.length,
        stem_types: Array.from(result.detectedTypes),
        stems: result.stems,
        sections: [], // Could be added later via analysis
        chords: [],   // Could be added later via analysis
        analysis: result.analysis,
      },
    });
    
  } catch (error) {
    console.error('[ZIP_UPLOAD_ERROR]', error);
    res.status(500).json({ error: 'Failed to process ZIP file', details: error.message });
  }
}

/**
 * Auto-analyze stems to create sections/chords
 */
async function analyzeStemsForMetadata(stems, songId) {
  console.log(`[ANALYZE] Analyzing ${stems.length} stems for metadata`);
  
  // This could integrate with CineStage AI for:
  // - Tempo detection
  // - Key detection
  // - Section detection (intro, verse, chorus)
  // - Chord progression mapping
  
  return {
    bpm: null, // Could detect from drums/click track
    key: null, // Could detect via pitch analysis
    time_signature: '4/4', // Default, could detect
    sections: [], // Could detect from structure
    chords: [],   // Could extract from keys/guitars
  };
}

module.exports = {
  processZipStems,
  handleZipUpload,
  detectStemType,
  analyzeStemsForMetadata,
};