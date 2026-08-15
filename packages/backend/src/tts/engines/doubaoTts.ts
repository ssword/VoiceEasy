import { Readable } from 'stream'
import { TTSEngine, TtsOptions } from '../types'
import { fetcher } from '../../utils/request'
import { logger } from '../../utils/logger'
import {
  createDoubaoAudioStream,
  defaultDoubaoWebSocketFactory,
  DoubaoWebSocketFactory,
} from './doubaoWebSocket'

export interface DoubaoTtsConfig {
  apiKey: string
  resourceId: string
  model: string
  voice?: string
}

export interface DoubaoTtsDependencies {
  createWebSocket?: DoubaoWebSocketFactory
}

type DoubaoResponse = {
  code?: number | string
  message?: string
  audio?: string
}

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/create'
const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts'
const MAX_TEXT_LENGTH = 3000

const DOUBAO_VOICES = [
  {
    Name: DEFAULT_VOICE,
    cnName: 'Vivi 2.0',
    Gender: 'Female',
    language: 'zh-CN',
    age: 'Young',
    ContentCategories: [],
    VoicePersonalities: [],
  },
  { Name: 'zh_female_xiaohe_uranus_bigtts', cnName: '小何 2.0', Gender: 'Female', language: 'zh-CN', age: 'Young', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_male_m191_uranus_bigtts', cnName: '云舟 2.0', Gender: 'Male', language: 'zh-CN', age: 'Adult', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_male_taocheng_uranus_bigtts', cnName: '小天 2.0', Gender: 'Male', language: 'zh-CN', age: 'Young', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_male_liufei_uranus_bigtts', cnName: '刘飞 2.0', Gender: 'Male', language: 'zh-CN', age: 'Adult', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_female_sophie_uranus_bigtts', cnName: '魅力苏菲 2.0', Gender: 'Female', language: 'zh-CN', age: 'Adult', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_female_sajiaoxuemei_uranus_bigtts', cnName: '撒娇学妹 2.0', Gender: 'Female', language: 'zh-CN', age: 'Young', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_female_peiqi_uranus_bigtts', cnName: '佩奇猪 2.0', Gender: 'Female', language: 'zh-CN', age: 'Young', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_female_yingyujiaoxue_uranus_bigtts', cnName: 'Tina 老师 2.0', Gender: 'Female', language: 'zh-CN', age: 'Adult', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_female_kefunvsheng_uranus_bigtts', cnName: '暖阳女声 2.0', Gender: 'Female', language: 'zh-CN', age: 'Adult', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh_female_xiaoxue_uranus_bigtts', cnName: '儿童绘本 2.0', Gender: 'Female', language: 'zh-CN', age: 'Young', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'en_male_tim_uranus_bigtts', cnName: 'Tim', Gender: 'Male', language: 'en-US', age: 'Adult', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'en_female_dacey_uranus_bigtts', cnName: 'Dacey', Gender: 'Female', language: 'en-US', age: 'Adult', ContentCategories: [], VoicePersonalities: [] },
]

export class DoubaoTtsEngine implements TTSEngine {
  readonly name = 'doubao-tts'
  readonly supportsSubtitles = false
  readonly outputFormat = 'mp3'
  readonly sampleRate = 24000
  readonly cacheNamespace: string
  private readonly config: Required<DoubaoTtsConfig>
  private readonly createWebSocket: DoubaoWebSocketFactory

  constructor(config: DoubaoTtsConfig, dependencies: DoubaoTtsDependencies = {}) {
    if (!config.apiKey) throw new Error('DOUBAO_API_KEY is required.')
    if (!config.resourceId) throw new Error('DOUBAO_RESOURCE_ID is required.')
    if (!config.model) throw new Error('DOUBAO_MODEL is required.')
    this.config = {
      ...config,
      voice: config.voice || DEFAULT_VOICE,
    }
    this.createWebSocket = dependencies.createWebSocket || defaultDoubaoWebSocketFactory
    this.cacheNamespace = `${this.name}:${this.config.resourceId}:${this.config.model}`
  }

  async synthesize(text: string, options: TtsOptions): Promise<Buffer | Readable> {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Input text is required.')
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(
        `Input text exceeds ${MAX_TEXT_LENGTH} characters for synchronous Doubao TTS.`
      )
    }

    if (options.stream) {
      return createDoubaoAudioStream(
        {
          apiKey: this.config.apiKey,
          resourceId: this.config.resourceId,
          speaker: options.voice || this.config.voice,
          model: this.config.model,
          payload: this.buildStreamingRequest(text, options),
          onDiagnostic: ({ status, audioBytes, error }) => {
            logger[status === 'completed' ? 'info' : 'warn'](
              `Doubao Streaming ${status}`,
              this.diagnosticMetadata(status, audioBytes, {
                speaker: options.voice || this.config.voice,
                model: this.config.model,
                error,
              })
            )
          },
        },
        this.createWebSocket
      )
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
      this.logSynthesisFailure(status ?? 'unavailable')
      throw new Error(
        status
          ? `Doubao TTS upstream request failed with status ${status}.`
          : 'Doubao TTS upstream request failed.'
      )
    }
    let audio: Buffer
    try {
      audio = decodeAudio(response.data)
    } catch (error) {
      this.logSynthesisFailure(response.status ?? 200)
      throw error
    }
    logger.info(
      'Doubao synthesis completed',
      this.diagnosticMetadata(response.status ?? 200, audio.length)
    )
    return audio
  }

  async getSupportedLanguages(): Promise<string[]> {
    return [
      'zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'es-MX', 'es-ES', 'de-DE', 'fr-FR',
      'pt-BR', 'th-TH', 'vi-VN', 'ms-MY', 'fil-PH', 'it-IT', 'ru-RU', 'nl-NL',
      'pl-PL', 'tr-TR',
    ]
  }

  async getVoiceOptions() {
    if (this.config.voice === DEFAULT_VOICE) return DOUBAO_VOICES
    return [
      {
        Name: this.config.voice,
        cnName: this.config.voice,
        Gender: 'All',
        language: 'zh-CN',
        age: 'All',
        ContentCategories: [],
        VoicePersonalities: [],
      },
      ...DOUBAO_VOICES,
    ]
  }

  private diagnosticMetadata(
    status: number | string,
    audioBytes: number,
    extra: Record<string, unknown> = {}
  ) {
    return {
      engine: this.name,
      resourceId: this.config.resourceId,
      status,
      audioBytes,
      ...extra,
    }
  }

  private logSynthesisFailure(status: number | string): void {
    logger.warn('Doubao synthesis failed', this.diagnosticMetadata(status, 0))
  }

  private buildRequest(text: string, options: TtsOptions): Record<string, unknown> {
    const controls = normalizedControls(options)
    const reqParams: Record<string, unknown> = {
      model: this.config.model,
      text_prompt: text,
      speaker: options.voice || this.config.voice,
      audio_config: {
        format: 'mp3',
        sample_rate: this.sampleRate,
        speech_rate: controls.speechRate,
        loudness_rate: controls.loudnessRate,
        pitch_rate: controls.pitch,
      },
    }
    if (!this.shouldSendModel()) delete reqParams.model
    return reqParams
  }

  private buildStreamingRequest(text: string, options: TtsOptions): Record<string, unknown> {
    const controls = normalizedControls(options)
    const reqParams: Record<string, unknown> = {
      text,
      model: this.config.model,
      speaker: options.voice || this.config.voice,
      audio_params: {
        format: 'mp3',
        sample_rate: this.sampleRate,
        speech_rate: controls.speechRate,
        loudness_rate: controls.loudnessRate,
      },
      additions: JSON.stringify({ post_process: { pitch: controls.pitch } }),
    }
    if (!this.shouldSendModel()) delete reqParams.model
    return { req_params: reqParams }
  }

  private shouldSendModel(): boolean {
    // The API documents model as a cloned-voice override. Sending the default
    // model for the standard resource can produce a provider-side 55000000.
    return this.config.resourceId !== 'seed-tts-2.0' || this.config.model !== 'seed-tts-2.0-standard'
  }
}

function normalizedControls(options: TtsOptions) {
  return {
    speechRate: clamp(parseAdjustment(options.rate, '%', 0), -50, 100),
    loudnessRate: clamp(parseAdjustment(options.volume, '%', 0), -50, 100),
    pitch: clamp(parseAdjustment(options.pitch, 'Hz', 0), -12, 12),
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
