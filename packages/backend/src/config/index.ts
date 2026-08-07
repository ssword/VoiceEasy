import dotenv from 'dotenv'
import { resolve, join } from 'path'

dotenv.config({
  path: [
    resolve(__dirname, '..', '..', '.env'),
    resolve(__dirname, '..', '..', '..', '..', '.env'),
  ],
})
export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
}

export const AUDIO_DIR = join(__dirname, '..', '..', 'audio')
export const AUDIO_CACHE_DIR = join(AUDIO_DIR, '.cache')
export const PUBLIC_DIR = join(__dirname, '..', '..', 'public')
export const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.srt'])

export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY
export const MODEL_NAME = process.env.MODEL_NAME
export const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '120000', 10)

export const STATIC_DOMAIN = process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : ''

export const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '0') || 10
export const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || '0') || 1e6

export const EDGE_API_LIMIT = parseInt(process.env.EDGE_API_LIMIT || '3') || 3

export const PORT = parseInt(process.env.PORT || '3000') || 3000

export const REGISTER_OPENAI_TTS = process.env.REGISTER_OPENAI_TTS || false

export const REGISTER_KOKORO = process.env.REGISTER_KOKORO || false
export const TTS_KOKORO_URL = process.env.TTS_KOKORO_URL || 'http://localhost:8880/v1'

export const REGISTER_COSYVOICE = process.env.REGISTER_COSYVOICE === 'true' || false
export const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || ''
export const DASHSCOPE_WORKSPACE_ID = process.env.DASHSCOPE_WORKSPACE_ID || ''
export const COSYVOICE_MODEL = process.env.COSYVOICE_MODEL || 'cosyvoice-v3-flash'

export const REGISTER_QWEN_AUDIO_TTS = process.env.REGISTER_QWEN_AUDIO_TTS === 'true' || false
export const QWEN_AUDIO_TTS_MODEL = process.env.QWEN_AUDIO_TTS_MODEL || 'qwen-audio-3.0-tts-plus'

export const LIMIT_TEXT_LENGTH = parseInt(process.env.LIMIT_TEXT_LENGTH || '0')
export const LIMIT_TEXT_LENGTH_ERROR_MESSAGE = process.env.LIMIT_TEXT_LENGTH_ERROR_MESSAGE
export const USE_HELMET = process.env.USE_HELMET === 'true' || false
export const USE_LIMIT = process.env.USE_LIMIT === 'true' || false
export const DIRECT_GEN_LIMIT = process.env.DIRECT_GEN_LIMIT || 200

export const DEFAULT_ENGINE = 'edge-tts'
