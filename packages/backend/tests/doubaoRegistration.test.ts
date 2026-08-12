describe('Doubao Engine registration', () => {
  const saved = {
    register: process.env.REGISTER_DOUBAO_TTS,
    apiKey: process.env.DOUBAO_API_KEY,
    resourceId: process.env.DOUBAO_RESOURCE_ID,
    model: process.env.DOUBAO_MODEL,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries({
      REGISTER_DOUBAO_TTS: saved.register,
      DOUBAO_API_KEY: saved.apiKey,
      DOUBAO_RESOURCE_ID: saved.resourceId,
      DOUBAO_MODEL: saved.model,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    jest.resetModules()
  })

  it('does not register Doubao when the opt-in switch is disabled', async () => {
    delete process.env.REGISTER_DOUBAO_TTS
    delete process.env.DOUBAO_API_KEY
    delete process.env.DOUBAO_RESOURCE_ID
    jest.resetModules()

    const { registerEngines } = await import('../src/tts/engines')
    const { ttsPluginManager } = await import('../src/tts/pluginManager')
    registerEngines()

    expect(ttsPluginManager.getEngine('doubao-tts')).toBeUndefined()
  })

  it('registers Doubao only with server-side configuration', async () => {
    process.env.REGISTER_DOUBAO_TTS = 'true'
    process.env.DOUBAO_API_KEY = 'private-test-key'
    process.env.DOUBAO_RESOURCE_ID = 'seed-tts-resource'
    process.env.DOUBAO_MODEL = 'seed-audio-1.0'
    jest.resetModules()

    const { registerEngines } = await import('../src/tts/engines')
    const { ttsPluginManager } = await import('../src/tts/pluginManager')
    registerEngines()

    expect(ttsPluginManager.getEngine('doubao-tts')).toEqual(
      expect.objectContaining({
        name: 'doubao-tts',
        cacheNamespace: 'doubao-tts:seed-tts-resource:seed-audio-1.0',
      })
    )
  })

  it('fails registration clearly when required server configuration is missing', async () => {
    process.env.REGISTER_DOUBAO_TTS = 'true'
    delete process.env.DOUBAO_API_KEY
    process.env.DOUBAO_RESOURCE_ID = 'seed-tts-resource'
    jest.resetModules()

    const { registerEngines } = await import('../src/tts/engines')
    expect(() => registerEngines()).toThrow('DOUBAO_API_KEY is required')
  })
})
