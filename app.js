import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { exec } from 'child_process'
import formatsRoute from './routes/formats.js'
import spotifyRoute from './routes/spotify.js'
import playlistRoute from './routes/playlist.js'
import jobsRoute from './routes/jobs.js'
import downloadRoute from './routes/download.js'
import { sendError } from './modules/utils.js'

const defaultEnv = process.env.ENV_DEFAULT_PATH
const userEnv = process.env.ENV_USER_PATH

if (defaultEnv && fs.existsSync(defaultEnv)) {
  dotenv.config({ path: defaultEnv })
  console.log('✅ Loaded defaults from', defaultEnv)
}
if (userEnv && fs.existsSync(userEnv)) {
  dotenv.config({ path: userEnv, override: true })
  console.log('✅ Loaded user overrides from', userEnv)
} else {
  const localEnv = path.join(process.cwd(), '.env')
  if (fs.existsSync(localEnv)) {
    dotenv.config({ path: localEnv, override: true })
    console.log('✅ Loaded local .env from', localEnv)
  }
}

const { default: settingsRoute } = await import('./modules/settings.js')
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const BASE_DIR = process.env.DATA_DIR || process.cwd()
const UPLOAD_DIR = path.resolve(BASE_DIR, 'uploads')
const OUTPUT_DIR = path.resolve(BASE_DIR, 'outputs')
const TEMP_DIR = path.resolve(BASE_DIR, 'temp')

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

if (process.env.YTDLP_COOKIES && process.env.YTDLP_COOKIES.startsWith('./')) {
  process.env.YTDLP_COOKIES = path.join(BASE_DIR, process.env.YTDLP_COOKIES.slice(2))
  try {
    fs.mkdirSync(path.dirname(process.env.YTDLP_COOKIES), { recursive: true })
  } catch {}
}

function checkDependencies() {
  return new Promise((resolve) => {
    const results = {
      ytDlp: false,
      ffmpeg: false
    }

    exec('yt-dlp --version', (error, stdout, stderr) => {
      if (!error && stdout.trim()) {
        results.ytDlp = true
        console.log(`✅ yt-dlp is working (version: ${stdout.trim()})`)
      } else {
        console.log('❌ yt-dlp is not available')
      }

      exec('ffmpeg -version', (error, stdout, stderr) => {
        if (!error && stdout.includes('ffmpeg version')) {
          results.ffmpeg = true
          const versionMatch = stdout.match(/ffmpeg version (\S+)/)
          const version = versionMatch ? versionMatch[1] : 'unknown'
          console.log(`✅ ffmpeg is working (version: ${version})`)
        } else {
          console.log('❌ ffmpeg is not available')
        }

        resolve(results)
      })
    })
  })
}

app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname, 'public')))

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) =>
    cb(null, `${crypto.randomBytes(8).toString('hex')}_${file.originalname}`)
})
export const upload = multer({
  storage,
  limits: { fileSize: 1000 * 1024 * 1024 }
})

app.use(formatsRoute)
app.use(spotifyRoute)
app.use(playlistRoute)
app.use(jobsRoute)
app.use(downloadRoute)
app.use('/api', settingsRoute)

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 'INTERNAL', 'File too large', 413)
  }
  if (err) {
    console.error('Unhandled error middleware:', err)
    return sendError(res, 'INTERNAL', err.message || 'internal', 500)
  }
  next()
})

const PORT = process.env.PORT || 5174

checkDependencies().then((results) => {
  app.listen(PORT, () => {
    console.log(`🚀 Server http://localhost:${PORT} running`)
    console.log(`📁 Base: ${BASE_DIR}`)
    console.log(`📁 Uploads: ${UPLOAD_DIR}`)
    console.log(`📁 Outputs: ${OUTPUT_DIR}`)
    console.log(`📁 Temp: ${TEMP_DIR}`)
    console.log('⚠️  Dependency Status:')
    console.log(`   ${results.ytDlp ? '✅' : '❌'} yt-dlp - ${results.ytDlp ? 'Available' : 'Required for YouTube support'}`)
    console.log(`   ${results.ffmpeg ? '✅' : '❌'} ffmpeg - ${results.ffmpeg ? 'Available' : 'Required for audio/video processing'}`)

    if (!results.ytDlp || !results.ffmpeg) {
      console.log('💡 Please install missing dependencies for full functionality')
    }
  })
})
