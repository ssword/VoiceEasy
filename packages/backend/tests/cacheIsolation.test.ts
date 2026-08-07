import { Readable } from 'stream'
import { generateTTS } from '../src/services/tts.service'
import { ttsPluginManager } from '../src/tts/pluginManager'
import { TTSEngine, TtsOptions } from '../src/tts/types'

const audioCache = new Map<string, any>()

jest.mock('../src/services/audioCache.service', () => ({
  __esModule: true,
  default: {
    getAudio: jest.fn((key: string) => Promise.resolve(audioCache.get(key) || null)),
    setAudio: jest.fn((key: string, value: any) => {
      audioCache.set(key, value)
      return Promise.resolve(true)
    }),
  },
}))

jest.mock('franc', () => ({
  franc: jest.fn(() => 'eng'),
}))

class CountingEngine implements TTSEngine {
  readonly supportsSubtitles = false
  calls = 0
  readonly optionsSeen: TtsOptions[] = []

  constructor(
    readonly name: string,
    readonly cacheNamespace: string,
    readonly outputFormat = 'mp3',
    readonly sampleRate = 24000
  ) {}

  async synthesize(_text: string, options: TtsOptions): Promise<Buffer | Readable> {
    this.calls++
    this.optionsSeen.push(options)
    const audio = Buffer.from(`ID3-${this.cacheNamespace}-${options.instruction || ''}`)
    return options.stream ? Readable.from(audio) : audio
  }

  async getSupportedLanguages() {
    return ['en-US']
  }

  async getVoiceOptions() {
    return ['en-US-AriaNeural']
  }
}

const request = (change: Record<string, unknown> = {}) =>
  ({
    text: 'A deterministic synthesis cache identity test.',
    voice: 'en-US-AriaNeural',
    pitch: '+0Hz',
    rate: '+0%',
    volume: '+0%',
    instruction: '',
    useLLM: false,
    engine: 'edge-tts',
    ...change,
  }) as any

describe('Ticket 02 — synthesis cache isolation', () => {
  beforeEach(() => {
    audioCache.clear()
  })

  it('reuses an identical synthesis and misses when engine, model, or instruction changes', async () => {
    const edgeV1 = new CountingEngine('edge-tts', 'edge-tts:model-v1')
    const alternate = new CountingEngine('alternate-tts', 'alternate-tts:model-v1')
    ttsPluginManager.replaceEngines([edgeV1, alternate])

    await generateTTS(request())
    await generateTTS(request())
    expect(edgeV1.calls).toBe(1)

    const outputFields = [
      { text: 'Different deterministic text.' },
      { voice: 'en-US-JennyNeural' },
      { rate: '+10%' },
      { pitch: '+10Hz' },
      { volume: '-10%' },
      { instruction: 'speak warmly' },
    ]
    for (const change of outputFields) await generateTTS(request(change))
    expect(edgeV1.calls).toBe(1 + outputFields.length)
    expect(edgeV1.optionsSeen.at(-1)?.instruction).toBe('speak warmly')

    await generateTTS(request({ engine: 'alternate-tts' }))
    expect(alternate.calls).toBe(1)

    const edgeV2 = new CountingEngine('edge-tts', 'edge-tts:model-v2')
    ttsPluginManager.replaceEngines([edgeV2, alternate])
    await generateTTS(request())
    expect(edgeV2.calls).toBe(1)

    const edgeWav = new CountingEngine('edge-tts', 'edge-tts:model-v2', 'wav', 24000)
    ttsPluginManager.replaceEngines([edgeWav, alternate])
    await generateTTS(request())
    expect(edgeWav.calls).toBe(1)

    const edge16Khz = new CountingEngine('edge-tts', 'edge-tts:model-v2', 'wav', 16000)
    ttsPluginManager.replaceEngines([edge16Khz, alternate])
    await generateTTS(request())
    expect(edge16Khz.calls).toBe(1)
  })
})
