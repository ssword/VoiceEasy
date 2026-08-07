describe('Qwen-Audio-TTS model configuration', () => {
  const originalModel = process.env.QWEN_AUDIO_TTS_MODEL

  beforeEach(() => {
    jest.resetModules()
    jest.doMock('dotenv', () => ({
      __esModule: true,
      default: { config: jest.fn() },
    }))
  })

  afterEach(() => {
    if (originalModel === undefined) delete process.env.QWEN_AUDIO_TTS_MODEL
    else process.env.QWEN_AUDIO_TTS_MODEL = originalModel
    jest.dontMock('dotenv')
  })

  it('defaults to qwen-audio-3.0-tts-plus when no model is configured', () => {
    delete process.env.QWEN_AUDIO_TTS_MODEL

    const { QWEN_AUDIO_TTS_MODEL } = require('../src/config')

    expect(QWEN_AUDIO_TTS_MODEL).toBe('qwen-audio-3.0-tts-plus')
  })

  it('keeps an explicit model override authoritative', () => {
    process.env.QWEN_AUDIO_TTS_MODEL = 'qwen-audio-3.0-tts-flash'

    const { QWEN_AUDIO_TTS_MODEL } = require('../src/config')

    expect(QWEN_AUDIO_TTS_MODEL).toBe('qwen-audio-3.0-tts-flash')
  })
})
