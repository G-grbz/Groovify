import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  PORT: process.env.PORT || 5174,
  UPLOAD_DIR: path.resolve(__dirname, 'uploads'),
  OUTPUT_DIR: path.resolve(__dirname, 'outputs'),
  MAX_FILE_SIZE: 100 * 1024 * 1024,
  MAX_CONCURRENT_JOBS: 2,
  BITRATE_OPTIONS: {
    mp3: ['128k', '192k', '256k', '320k'],
    flac: ['lossless'],
    wav: ['lossless'],
    ogg: ['128k', '192k', '256k']
  },
  FORMAT_SETTINGS: {
    mp3: {
      codec: 'libmp3lame',
      extension: 'mp3'
    },
    flac: {
      codec: 'flac',
      extension: 'flac'
    },
    wav: {
      codec: 'pcm_s16le',
      extension: 'wav'
    },
    ogg: {
      codec: 'libvorbis',
      extension: 'ogg'
    }
  }
};
