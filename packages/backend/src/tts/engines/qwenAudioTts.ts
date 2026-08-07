import { Readable } from 'stream'
import { TTSEngine, TtsOptions } from '../types'
import {
  collectAudio,
  DashScopeConfig,
  DashScopeTransport,
  decodeBase64,
  decodeDashScopeSse,
} from './dashscopeBase'

type Voice = {
  Name: string
  cnName: string
  Gender: string
  language: string
  VoicePersonalities: string[]
  ContentCategories: string[]
}

const voice = (
  Name: string,
  cnName: string,
  Gender: string,
  language: string,
  personality = ''
): Voice => ({
  Name,
  cnName,
  Gender,
  language,
  VoicePersonalities: personality ? [personality] : [],
  ContentCategories: [],
})

// Only directly usable system Voices belong here. Clone-only datasets are intentionally excluded.
const MODEL_VOICES: Record<string, Voice[]> = {
  'qwen-audio-3.0-tts-flash': [
    voice('longanfengyue', '龙安风月', 'Female', 'zh-CN', '自然亲和音'),
    voice('longanyuanfei', '龙安元菲', 'Female', 'zh-CN', '骄傲御姐音'),
    voice('longanlingxi', '龙安灵犀', 'Female', 'zh-CN', '可爱甜美音'),
    voice('longanxiaoxin', '龙安小欣', 'Female', 'zh-CN', '亲切活泼湖北音'),
    voice('longanhuan_v3.6', '龙安欢', 'Female', 'zh-CN'),
    voice('longjielidou_v3.6', '龙杰力豆', 'Male', 'zh-CN', '天真童趣音'),
    voice('longpaopao_v3.6', '龙泡泡', 'Female', 'zh-CN', '软萌可爱音'),
    voice('longhuohuo_v3.6', '龙火火', 'Male', 'zh-CN', '顽皮少年音'),
    voice('longchuanshu_v3.6', '龙传书', 'Male', 'zh-CN', '四川口音'),
    voice('loongmary', 'Mary', 'Female', 'en-US', '英式口音'),
    voice('loongeva_v3.6', 'Eva', 'Female', 'en-US', '美式口音'),
    voice('loongjohn', 'John', 'Male', 'en-US', '美式口音'),
  ],
  'qwen-audio-3.0-tts-plus': [
    voice('longanlingxin', '龙安灵心', 'Female', 'zh-CN', '知心温暖音'),
    voice('longanlufeng', '龙安陆风', 'Male', 'zh-CN', '明亮开朗湖北音'),
  ],
}

export class QwenAudioTtsEngine implements TTSEngine {
  readonly name = 'qwen-audio-tts'
  readonly supportsSubtitles = false
  readonly cacheNamespace: string
  readonly outputFormat = 'mp3'
  readonly sampleRate = 24000
  private readonly transport: DashScopeTransport
  private readonly voices: Voice[]

  constructor(config: DashScopeConfig) {
    const voices = MODEL_VOICES[config.model]
    if (!voices) {
      throw new Error(`Unsupported Qwen-Audio-TTS model: ${config.model}`)
    }
    this.transport = new DashScopeTransport(config, this.name)
    this.voices = voices
    this.cacheNamespace = `${this.name}:${config.model}`
  }

  async synthesize(text: string, options: TtsOptions): Promise<Buffer | Readable> {
    if (!text) throw new Error('Input text is required.')
    const stream = await this.synthesizeStream(text, options)
    return options.stream ? stream : collectAudio(stream, this.name)
  }

  async getSupportedLanguages(): Promise<string[]> {
    return [
      'zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'pt-PT',
      'it-IT', 'ru-RU', 'ar-SA', 'id-ID', 'ms-MY', 'th-TH', 'tl-PH', 'vi-VN',
    ]
  }

  async getVoiceOptions(): Promise<Voice[]> {
    return this.voices
  }

  private async synthesizeStream(text: string, options: TtsOptions): Promise<Readable> {
    const upstream = await this.transport.stream(this.buildRequest(text, options))
    return decodeDashScopeSse(upstream, {
      engineName: this.name,
      decodeAudio: (event) => {
        const data = event as any
        return decodeBase64(data?.output?.audio?.data ?? data?.audio?.data ?? data?.data, 'Qwen event')
      },
    })
  }

  private buildRequest(text: string, options: TtsOptions): Record<string, unknown> {
    const input: Record<string, unknown> = {
      text,
      voice: options.voice || this.voices[0].Name,
      format: 'mp3',
      sample_rate: 24000,
      rate: normalizeRate(options.rate),
      volume: normalizeVolume(options.volume),
    }
    if (options.instruction) input.instruction = options.instruction
    return { model: this.transport.model, input }
  }
}

function normalizeVolume(value: number | string | undefined): number {
  if (value == null) return 50
  if (typeof value === 'string') {
    const percent = value.match(/^([+-]?\d+)%$/)
    if (percent) return clamp(50 + Number(percent[1]), 0, 100)
    const parsed = Number(value)
    return Number.isFinite(parsed) ? clamp(parsed <= 1 ? parsed * 100 : parsed, 0, 100) : 50
  }
  return clamp(value <= 1 ? value * 100 : value, 0, 100)
}

function normalizeRate(value: number | string | undefined): number {
  if (value == null) return 1
  if (typeof value === 'string') {
    const percent = value.match(/^([+-]?\d+)%$/)
    if (percent) return clamp(1 + Number(percent[1]) / 100, 0.5, 2)
    const parsed = Number(value)
    return Number.isFinite(parsed) ? clamp(parsed, 0.5, 2) : 1
  }
  return clamp(value, 0.5, 2)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
