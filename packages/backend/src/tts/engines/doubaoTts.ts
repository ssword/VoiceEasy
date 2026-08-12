import { Readable } from 'stream'
import { TTSEngine, TtsOptions } from '../types'
import { fetcher } from '../../utils/request'

export interface DoubaoTtsConfig {
  apiKey: string
  resourceId: string
  model: string
  speaker?: string
}

type DoubaoResponse = {
  code?: number | string
  message?: string
  audio?: string
}

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/create'
const DEFAULT_SPEAKER = 'zh_female_tianmeitaozi_mars_bigtts'
const MAX_TEXT_LENGTH = 3000

const DOUBAO_VOICES = [
  {
    Name: DEFAULT_SPEAKER,
    cnName: '甜美桃子',
    Gender: 'Female',
    language: 'zh-CN',
    age: 'Young',
    ContentCategories: [],
    VoicePersonalities: [],
  },
]

export class DoubaoTtsEngine implements TTSEngine {
  readonly name = 'doubao-tts'
  readonly supportsSubtitles = false
  readonly outputFormat = 'mp3'
  readonly sampleRate = 24000
  readonly cacheNamespace: string
  private readonly config: Required<DoubaoTtsConfig>

  constructor(config: DoubaoTtsConfig) {
    if (!config.apiKey) throw new Error('DOUBAO_API_KEY is required.')
    if (!config.resourceId) throw new Error('DOUBAO_RESOURCE_ID is required.')
    if (!config.model) throw new Error('DOUBAO_MODEL is required.')
    this.config = {
      ...config,
      speaker: config.speaker || DEFAULT_SPEAKER,
    }
    this.cacheNamespace = `${this.name}:${this.config.resourceId}:${this.config.model}`
  }

  async synthesize(text: string, options: TtsOptions): Promise<Buffer | Readable> {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Input text is required.')
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(`Input text exceeds ${MAX_TEXT_LENGTH} characters for synchronous Doubao TTS.`)
    }

    let response
    try {
      response = await fetcher.post<DoubaoResponse>(
        ENDPOINT,
        this.buildRequest(text, options),
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': this.config.apiKey,
            'X-Api-Resource-Id': this.config.resourceId,
          },
        }
      )
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status
      throw new Error(
        status
          ? `Doubao TTS upstream request failed with status ${status}.`
          : 'Doubao TTS upstream request failed.'
      )
    }
    return decodeAudio(response.data)
  }

  async getSupportedLanguages(): Promise<string[]> {
    return [
      'zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'es-MX', 'es-ES', 'de-DE', 'fr-FR',
      'pt-BR', 'th-TH', 'vi-VN', 'ms-MY', 'fil-PH', 'it-IT', 'ru-RU', 'nl-NL',
      'pl-PL', 'tr-TR',
    ]
  }

  async getVoiceOptions() {
    return DOUBAO_VOICES
  }

  private buildRequest(text: string, options: TtsOptions): Record<string, unknown> {
    return {
      model: this.config.model,
      text_prompt: text,
      speaker: options.voice || this.config.speaker,
      audio_config: {
        format: 'mp3',
        sample_rate: this.sampleRate,
        speech_rate: clamp(parseAdjustment(options.rate, '%', 0), -50, 100),
        loudness_rate: clamp(parseAdjustment(options.volume, '%', 0), -50, 100),
        pitch_rate: clamp(parseAdjustment(options.pitch, 'Hz', 0), -12, 12),
      },
    }
  }
}

function decodeAudio(response: DoubaoResponse | undefined): Buffer {
  if (!response || response.code !== 0) {
    const code = response?.code ?? 'unknown'
    throw new Error(`Doubao TTS API error: ${code}`)
  }
  const encodedAudio = response.audio
  if (typeof encodedAudio !== 'string' || !encodedAudio) {
    throw new Error('Doubao response missing Base64 MP3 audio.')
  }

  let audio: Buffer
  if (!isBase64(encodedAudio)) {
    throw new Error('Doubao response contains invalid Base64 MP3 audio.')
  }
  try {
    audio = Buffer.from(encodedAudio, 'base64')
  } catch {
    throw new Error('Doubao response contains invalid Base64 MP3 audio.')
  }
  if (!audio.length) throw new Error('Doubao response missing Base64 MP3 audio.')
  if (!isMp3(audio)) throw new Error('Doubao response is not MP3-compatible.')
  return audio
}

function isMp3(audio: Buffer): boolean {
  return audio.subarray(0, 3).toString('ascii') === 'ID3' ||
    (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
}

function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

function parseAdjustment(value: unknown, suffix: '%' | 'Hz', fallback: number): number {
  if (value == null || value === '') return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  const text = String(value).trim()
  const numeric = Number(text.replace(suffix, '').replace('%', ''))
  return Number.isFinite(numeric) ? numeric : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
