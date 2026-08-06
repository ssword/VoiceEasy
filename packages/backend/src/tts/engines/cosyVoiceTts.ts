import { Readable, PassThrough } from 'stream'
import { spawn } from 'child_process'
import { TTSEngine, TtsOptions } from '../types'
import { fetcher } from '../../utils/request'
import { logger } from '../../utils/logger'

interface CosyVoiceConfig {
  apiKey: string
  workspaceId: string
  model: string
}

const COSYVOICE_VOICES = [
  'longxiaochun',
  'longyu',
  'longchen',
  'longyue',
  'longzhe',
  'longfei',
  'longbai',
  'longshu',
  'longjing',
  'longyi',
]

export class CosyVoiceTtsEngine implements TTSEngine {
  name = 'cosyvoice-tts'
  supportsSubtitles = false
  private baseUrl: string
  private apiKey: string
  private model: string

  constructor(config: CosyVoiceConfig) {
    if (!config.apiKey) {
      throw new Error('CosyVoice TTS requires DASHSCOPE_API_KEY.')
    }
    if (!config.workspaceId) {
      throw new Error('CosyVoice TTS requires DASHSCOPE_WORKSPACE_ID.')
    }
    this.apiKey = config.apiKey
    this.model = config.model || 'cosyvoice-v3-flash'
    this.baseUrl = `https://${config.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
  }

  async synthesize(text: string, options: TtsOptions): Promise<Buffer | Readable> {
    const { voice = 'longxiaochun', speed = 1.0, volume = 1.0, stream = false } = options

    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Input text is required.')
    }

    const requestBody = {
      model: this.model,
      input: {
        text,
        voice,
        format: 'mp3',
      },
      parameters: {
        sample_rate: 24000,
        speed,
        volume: typeof volume === 'number' ? Math.max(0, Math.min(1, volume)) : 1.0,
      },
    }

    if (stream) {
      return this.synthesizeStream(requestBody)
    }
    return this.synthesizeBuffer(requestBody)
  }

  /**
   * Non-streaming: POST → get audio URL → download → return Buffer.
   */
  private async synthesizeBuffer(requestBody: unknown): Promise<Buffer> {
    logger.info('[CosyVoice] Non-streaming synthesis request')
    const response = await fetcher.post<{ output?: { audio_url?: string }; code?: string; message?: string }>(
      this.baseUrl,
      requestBody as Record<string, unknown>,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    )

    const data = response.data
    if (!data || data.code) {
      throw new Error(`CosyVoice API error: ${data?.message || 'unknown error'}`)
    }

    const audioUrl = data?.output?.audio_url
    if (!audioUrl) {
      throw new Error('CosyVoice response missing audio_url')
    }

    logger.info(`[CosyVoice] Downloading audio from URL: ${audioUrl.slice(0, 80)}...`)
    const audioResponse = await fetcher.get<ArrayBuffer>(audioUrl, undefined, {
      responseType: 'arraybuffer',
    })
    return Buffer.from(audioResponse.data as unknown as ArrayBuffer)
  }

  /**
   * Streaming: POST with X-DashScope-SSE → parse SSE → decode base64 PCM → ffmpeg → MP3 Readable.
   */
  private async synthesizeStream(requestBody: unknown): Promise<Readable> {
    logger.info('[CosyVoice] Streaming synthesis request')
    const response = await fetcher.post(this.baseUrl, requestBody as Record<string, unknown>, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'enable',
      },
      responseType: 'stream',
      timeout: 120_000,
    })

    const sseStream = response.data as Readable
    const pcmStream = this.parseSSEToPcm(sseStream)
    return this.pcmToMp3Stream(pcmStream)
  }

  /**
   * Parse SSE text stream to raw PCM binary stream.
   * SSE format: data:{"header":{...},"payload":{"chunk":"<base64>"}}
   * Non-JSON data lines are PCM already (some versions of the API).
   */
  private parseSSEToPcm(sseStream: Readable): Readable {
    const out = new PassThrough()
    let buffer = ''

    sseStream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data:[DONE]') continue

        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim()
          try {
            const parsed = JSON.parse(payload)
            const base64Chunk = parsed?.payload?.chunk
            if (base64Chunk) {
              const pcmBuffer = Buffer.from(base64Chunk, 'base64')
              out.push(pcmBuffer)
            }
          } catch {
            // If not valid JSON, treat as raw base64 (some API versions)
            try {
              const pcmBuffer = Buffer.from(payload, 'base64')
              out.push(pcmBuffer)
            } catch {
              // Skip unparseable lines
            }
          }
        }
      }
    })

    sseStream.on('end', () => {
      // Process remaining buffer
      if (buffer.trim() && buffer.trim() !== 'data:[DONE]') {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim()
          try {
            const parsed = JSON.parse(payload)
            const base64Chunk = parsed?.payload?.chunk
            if (base64Chunk) {
              out.push(Buffer.from(base64Chunk, 'base64'))
            }
          } catch {
            // skip
          }
        }
      }
      out.end()
    })

    sseStream.on('error', (err) => {
      logger.error('[CosyVoice] SSE stream error:', err.message)
      out.destroy(err)
    })

    return out
  }

  /**
   * Convert PCM audio stream to MP3 via ffmpeg child process.
   * PCM parameters: 24kHz, 16-bit, mono (matching CosyVoice default).
   */
  private pcmToMp3Stream(pcmStream: Readable): Readable {
    const ffmpegArgs = [
      '-f', 's16le',       // signed 16-bit little-endian PCM
      '-ar', '24000',      // 24kHz sample rate
      '-ac', '1',           // mono
      '-i', 'pipe:0',      // stdin
      '-f', 'mp3',          // output format
      '-b:a', '96k',        // bitrate
      'pipe:1',             // stdout
    ]

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    pcmStream.pipe(ffmpeg.stdin!)

    ffmpeg.stderr?.on('data', (data: Buffer) => {
      logger.debug(`[CosyVoice] ffmpeg: ${data.toString().trim()}`)
    })

    ffmpeg.on('error', (err) => {
      logger.error('[CosyVoice] ffmpeg process error:', err.message)
    })

    // Wrap stdout as Readable and clean up on close
    const mp3Stream = ffmpeg.stdout! as Readable
    const cleanup = () => {
      if (!ffmpeg.killed) {
        ffmpeg.kill()
      }
    }
    mp3Stream.on('close', cleanup)
    mp3Stream.on('error', cleanup)
    pcmStream.on('error', cleanup)

    return mp3Stream
  }

  async getSupportedLanguages(): Promise<string[]> {
    return ['zh-CN', 'en-US']
  }

  async getVoiceOptions(): Promise<string[]> {
    return COSYVOICE_VOICES
  }
}
