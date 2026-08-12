import { DoubaoTtsEngine } from '../src/tts/engines/doubaoTts'
import { fetcher } from '../src/utils/request'
import { createSynthesisCacheIdentity } from '../src/services/synthesisCache'
import { ttsPluginManager } from '../src/tts/pluginManager'

jest.mock('../src/utils/request', () => ({
  fetcher: { post: jest.fn() },
}))

const mp3 = Buffer.from('ID3-deterministic-doubao-audio').toString('base64')

describe('Doubao TTS Engine', () => {
  const config = {
    apiKey: 'private-doubao-key',
    resourceId: 'seed-tts-resource',
    model: 'seed-audio-1.0',
    voice: 'deployment-default-voice',
  }

  beforeEach(() => jest.clearAllMocks())

  it('sends the documented HTTP request with normalized common controls', async () => {
    jest.mocked(fetcher.post).mockResolvedValue({ data: { code: 0, audio: mp3 } } as any)
    const engine = new DoubaoTtsEngine(config)

    await expect(
      engine.synthesize('Doubao request fixture', {
        voice: 'requested-voice',
        rate: '+250%',
        volume: '-200%',
        pitch: '+99Hz',
      })
    ).resolves.toEqual(Buffer.from('ID3-deterministic-doubao-audio'))

    expect(fetcher.post).toHaveBeenCalledWith(
      'https://openspeech.bytedance.com/api/v3/tts/create',
      {
        model: 'seed-audio-1.0',
        text_prompt: 'Doubao request fixture',
        speaker: 'requested-voice',
        audio_config: {
          format: 'mp3',
          sample_rate: 24000,
          speech_rate: 100,
          loudness_rate: -50,
          pitch_rate: 12,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'private-doubao-key',
          'X-Api-Resource-Id': 'seed-tts-resource',
        },
      }
    )
  })

  it('uses the configured default Voice and exposes static Voice metadata', async () => {
    jest.mocked(fetcher.post).mockResolvedValue({ data: { code: 0, audio: mp3 } } as any)
    const engine = new DoubaoTtsEngine(config)

    await engine.synthesize('default voice fixture', {})

    expect(jest.mocked(fetcher.post).mock.calls[0][1]).toEqual(
      expect.objectContaining({ speaker: 'deployment-default-voice' })
    )
    await expect(engine.getVoiceOptions()).resolves.toContainEqual(
      expect.objectContaining({
        Name: 'zh_female_tianmeitaozi_mars_bigtts',
        cnName: '甜美桃子',
        Gender: 'Female',
        language: 'zh-CN',
      })
    )
    expect(engine).toEqual(
      expect.objectContaining({
        name: 'doubao-tts',
        supportsSubtitles: false,
        cacheNamespace: 'doubao-tts:seed-tts-resource:seed-audio-1.0',
        outputFormat: 'mp3',
        sampleRate: 24000,
      })
    )
  })

  it('isolates synthesis cache identity by resource and model', () => {
    const first = new DoubaoTtsEngine(config)
    ttsPluginManager.replaceEngines([first])
    const firstIdentity = createSynthesisCacheIdentity({
      engine: first.name,
      text: 'cache fixture',
      voice: first.name,
    })
    const second = new DoubaoTtsEngine({ ...config, resourceId: 'another-resource' })
    ttsPluginManager.replaceEngines([second])
    const secondIdentity = createSynthesisCacheIdentity({
      engine: second.name,
      text: 'cache fixture',
      voice: second.name,
    })
    const third = new DoubaoTtsEngine({ ...config, model: 'another-model' })
    ttsPluginManager.replaceEngines([third])
    const thirdIdentity = createSynthesisCacheIdentity({
      engine: third.name,
      text: 'cache fixture',
      voice: third.name,
    })

    expect(firstIdentity.cacheNamespace).not.toBe(secondIdentity.cacheNamespace)
    expect(firstIdentity.cacheNamespace).not.toBe(thirdIdentity.cacheNamespace)
  })

  it.each([
    ['missing API Key', { ...config, apiKey: '' }, 'DOUBAO_API_KEY is required'],
    ['missing resource ID', { ...config, resourceId: '' }, 'DOUBAO_RESOURCE_ID is required'],
    ['missing model', { ...config, model: '' }, 'DOUBAO_MODEL is required'],
  ])('rejects %s configuration', (_name, invalidConfig, message) => {
    expect(() => new DoubaoTtsEngine(invalidConfig)).toThrow(message)
  })

  it.each([
    [
      'upstream failure',
      { code: 3001, message: 'upstream rejected request' },
      'Doubao TTS API error: 3001',
    ],
    ['malformed response', { code: 0, audio: { unexpected: true } }, 'missing Base64 MP3 audio'],
    ['invalid Base64', { code: 0, audio: '!!!!' }, 'invalid Base64 MP3 audio'],
    ['empty audio', { code: 0, audio: '' }, 'missing Base64 MP3 audio'],
    [
      'non-MP3 audio',
      { code: 0, audio: Buffer.from('not-mp3').toString('base64') },
      'not MP3-compatible',
    ],
  ])('rejects %s without exposing credentials', async (_name, response, message) => {
    jest.mocked(fetcher.post).mockResolvedValue({ data: response } as any)
    const engine = new DoubaoTtsEngine(config)

    await expect(engine.synthesize('error fixture', {})).rejects.toThrow(message)
    await expect(engine.synthesize('error fixture', {})).rejects.not.toThrow(config.apiKey)
  })

  it('translates transport failures without exposing request credentials', async () => {
    jest.mocked(fetcher.post).mockRejectedValue({ response: { status: 401 } })
    const engine = new DoubaoTtsEngine(config)

    await expect(engine.synthesize('transport failure', {})).rejects.toThrow(
      'Doubao TTS upstream request failed with status 401.'
    )
    await expect(engine.synthesize('transport failure', {})).rejects.not.toThrow(config.apiKey)
  })

  it('rejects text over the synchronous request limit', async () => {
    const engine = new DoubaoTtsEngine(config)
    jest.mocked(fetcher.post).mockResolvedValue({ data: { code: 0, audio: mp3 } } as any)
    await expect(engine.synthesize('a'.repeat(3000), {})).resolves.toBeInstanceOf(Buffer)
    await expect(engine.synthesize('a'.repeat(3001), {})).rejects.toThrow('3000 characters')
    expect(fetcher.post).toHaveBeenCalledTimes(1)
  })
})
