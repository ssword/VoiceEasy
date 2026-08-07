import http from 'http'
import { AddressInfo } from 'net'
import { createApp } from '../src/app'
import { AUDIO_DIR, PUBLIC_DIR } from '../src/config'
import { Readable } from 'stream'
import { TTSEngine, TtsOptions } from '../src/tts/types'

// Mock franc (ESM) — Jest cannot parse its import statements in CJS mode.
// Dynamic import('franc') in getLangConfig will resolve to this mock.
jest.mock('franc', () => ({
  franc: jest.fn((text: string) => {
    // Simple heuristic: detect Chinese characters
    return /[\u4e00-\u9fff]/.test(text) ? 'cmn' : 'eng'
  }),
}))

// Use a temp directory for audio during tests
const TEST_AUDIO_DIR = AUDIO_DIR
const TEST_PUBLIC_DIR = PUBLIC_DIR
const RATE_LIMIT = 1e6
const RATE_LIMIT_WINDOW = 10

// Bound for local HTTP synthesis tests using deterministic fake Engine Plugins.
const TTS_TIMEOUT = 30_000

function createTestServer(edgeSupportsSubtitles = true) {
  class FakeEngine implements TTSEngine {
    constructor(
      readonly name: string,
      readonly supportsSubtitles: boolean
    ) {}

    async synthesize(_text: string, options: TtsOptions): Promise<Buffer | Readable> {
      const audio = Buffer.from('ID3-deterministic-test-audio')
      return options.stream ? Readable.from([audio]) : audio
    }

    async getSupportedLanguages() {
      return ['en-US', 'zh-CN']
    }

    async getVoiceOptions() {
      if (this.name === 'edge-tts') return ['en-US-AriaNeural', 'en-US-JennyNeural']
      if (this.name === 'qwen-audio-tts') {
        return [{ Name: 'longanlingxin', Gender: 'Female', language: 'zh-CN' }]
      }
      return [{ Name: 'longxiaochun', Gender: 'Female', language: 'zh-CN' }]
    }
  }

  const engines: TTSEngine[] = [
    new FakeEngine('edge-tts', edgeSupportsSubtitles),
    new FakeEngine('cosyvoice-tts', false),
    new FakeEngine('qwen-audio-tts', false),
  ]
  const app = createApp({
    isDev: true,
    rateLimit: RATE_LIMIT,
    rateLimitWindow: RATE_LIMIT_WINDOW,
    audioDir: TEST_AUDIO_DIR,
    publicDir: TEST_PUBLIC_DIR,
    engines,
  })
  return http.createServer(app)
}

async function fetchFromServer(
  server: http.Server,
  path: string,
  options: RequestInit = {}
): Promise<{ status: number; data: any; headers: Headers }> {
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}`
  const res = await fetch(`${baseUrl}${path}`, options)
  const contentType = res.headers.get('content-type') || ''
  let data: any
  if (contentType.includes('application/json')) {
    data = await res.json()
  } else {
    data = await res.text()
  }
  return { status: res.status, data, headers: res.headers }
}

async function isEngineRegistered(server: http.Server, engineName: string): Promise<boolean> {
  const { data } = await fetchFromServer(server, '/api/v1/tts/engines')
  return data.data?.some((e: any) => e.name === engineName) ?? false
}

describe('Ticket 01 — Backend API: Engine param + voice list + /engines contract', () => {
  let server: http.Server

  beforeAll((done) => {
    server = createTestServer()
    server.listen(0, () => done())
  })

  afterAll((done) => {
    server.close(() => done())
  })

  describe('GET /api/v1/tts/engines', () => {
    it('returns EdgeTTS engine always', async () => {
      const { status, data } = await fetchFromServer(server, '/api/v1/tts/engines')
      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(Array.isArray(data.data)).toBe(true)
      const edgeTts = data.data.find((e: any) => e.name === 'edge-tts')
      expect(edgeTts).toBeDefined()
      expect(edgeTts.name).toBe('edge-tts')
      expect(edgeTts.supportsSubtitles).toBe(true)
    })

    it('each engine has name, languages, voices (resolved array), supportsSubtitles', async () => {
      const { status, data } = await fetchFromServer(server, '/api/v1/tts/engines')
      expect(status).toBe(200)
      for (const engine of data.data) {
        expect(engine).toHaveProperty('name')
        expect(typeof engine.name).toBe('string')
        expect(engine).toHaveProperty('languages')
        expect(Array.isArray(engine.languages)).toBe(true)
        expect(engine).toHaveProperty('voices')
        expect(Array.isArray(engine.voices)).toBe(true)
        expect(engine.voices.every((voice: any) => typeof voice.Name === 'string')).toBe(true)
        expect(engine).toHaveProperty('supportsSubtitles')
        expect(typeof engine.supportsSubtitles).toBe('boolean')
      }
    })

    it('EdgeTTS voices array is non-empty', async () => {
      const { status, data } = await fetchFromServer(server, '/api/v1/tts/engines')
      expect(status).toBe(200)
      const edgeTts = data.data.find((e: any) => e.name === 'edge-tts')
      expect(edgeTts.voices.length).toBeGreaterThan(0)
    })

    it('returns deterministic CosyVoice and Qwen Engine Plugin contracts', async () => {
      const { status, data } = await fetchFromServer(server, '/api/v1/tts/engines')
      expect(status).toBe(200)
      const cosyVoice = data.data.find((e: any) => e.name === 'cosyvoice-tts')
      const qwen = data.data.find((e: any) => e.name === 'qwen-audio-tts')
      expect(cosyVoice).toEqual(expect.objectContaining({ supportsSubtitles: false }))
      expect(cosyVoice.voices).toContainEqual(expect.objectContaining({ Name: 'longxiaochun' }))
      expect(qwen).toEqual(expect.objectContaining({ supportsSubtitles: false }))
      expect(qwen.voices).toContainEqual(expect.objectContaining({ Name: 'longanlingxin' }))
    })
  })

  describe('GET /api/v1/tts/voiceList', () => {
    it('returns default voice list without engine param (backward compat)', async () => {
      const { status, data } = await fetchFromServer(server, '/api/v1/tts/voiceList')
      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.data).toBeDefined()
    })

    it('returns voice list for edge-tts engine', async () => {
      const { status, data } = await fetchFromServer(
        server,
        '/api/v1/tts/voiceList?engine=edge-tts'
      )
      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.data).toBeDefined()
      expect(Array.isArray(data.data)).toBe(true)
      expect(typeof data.data[0].Name).toBe('string')
      expect(typeof data.data[0].Gender).toBe('string')
      expect(Array.isArray(data.data[0].ContentCategories)).toBe(true)
      expect(Array.isArray(data.data[0].VoicePersonalities)).toBe(true)
    })

    it('returns 400 for unregistered engine', async () => {
      const { status, data } = await fetchFromServer(
        server,
        '/api/v1/tts/voiceList?engine=nonexistent-tts'
      )
      expect(status).toBe(400)
      expect(data.success).toBe(false)
      expect(data.message).toContain('Unsupported TTS engine')
    })

    it('returns CosyVoice voice list when engine is registered', async () => {
      // First check if cosyvoice is registered
      const { data: enginesData } = await fetchFromServer(server, '/api/v1/tts/engines')
      const cosyVoice = enginesData.data.find((e: any) => e.name === 'cosyvoice-tts')

      expect(cosyVoice).toBeDefined()
      const { status, data } = await fetchFromServer(
        server,
        '/api/v1/tts/voiceList?engine=cosyvoice-tts'
      )
      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(Array.isArray(data.data)).toBe(true)
      expect(data.data).toContainEqual(
        expect.objectContaining({ Name: 'longxiaochun', language: 'zh-CN' })
      )
    })

    it('returns the configured Qwen system Voice list', async () => {
      const { status, data } = await fetchFromServer(
        server,
        '/api/v1/tts/voiceList?engine=qwen-audio-tts'
      )

      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.data).toEqual([
        expect.objectContaining({ Name: 'longanlingxin', language: 'zh-CN' }),
      ])
    })
  })

  describe('Schema validation: engine field', () => {
    it('POST /generate with invalid engine returns 400', async () => {
      const { status, data } = await fetchFromServer(server, '/api/v1/tts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Hello world this is a test',
          voice: 'en-US-AriaNeural',
          engine: 'nonexistent-tts',
        }),
      })
      expect(status).toBe(400)
      expect(data.success).toBe(false)
    })

    it('POST /createStream with invalid engine returns 400', async () => {
      const { status, data } = await fetchFromServer(server, '/api/v1/tts/createStream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Hello world this is a test',
          voice: 'en-US-AriaNeural',
          engine: 'nonexistent-tts',
        }),
      })
      expect(status).toBe(400)
      expect(data.success).toBe(false)
    })
  })
})

describe('Ticket 05 — generateJson per-segment engine override', () => {
  let server: http.Server

  beforeAll((done) => {
    server = createTestServer(false)
    server.listen(0, () => done())
  })

  afterAll((done) => {
    server.closeAllConnections?.()
    server.close(() => done())
  })

  /** Helper: fetch streaming endpoint for generateJson, drain body after header check. */
  async function fetchJsonStream(body: unknown): Promise<Response> {
    const addr = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/tts/generateJson`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // Drain the body in the background so the connection can close and the test doesn't hang.
    res.body?.pipeTo(
      new WritableStream({ write() { /* drain */ } })
    ).catch(() => { /* ignore drain errors */ })
    return res
  }

  it(
    'POST /generateJson returns streaming audio with default engine per segment',
    async () => {
      const res = await fetchJsonStream({
        data: [
          { text: 'Hello world, this is segment one.', voice: 'en-US-AriaNeural' },
          { text: 'This is segment two with a different voice.', voice: 'en-US-JennyNeural' },
        ],
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type') || '').toContain('application/octet-stream')
      expect(res.headers.get('x-generate-tts-type')).toBe('stream')
    },
    TTS_TIMEOUT
  )

  it(
    'POST /generateJson with explicit per-segment engine override',
    async () => {
      const res = await fetchJsonStream({
        data: [
          {
            text: 'Hello world, this uses edge tts explicitly.',
            voice: 'en-US-AriaNeural',
            engine: 'edge-tts',
          },
          {
            text: 'This also uses edge tts.',
            voice: 'en-US-JennyNeural',
            engine: 'edge-tts',
          },
        ],
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type') || '').toContain('application/octet-stream')
      expect(res.headers.get('x-generate-tts-type')).toBe('stream')
    },
    TTS_TIMEOUT
  )

  it(
    'POST /generateJson with mixed engines (EdgeTTS + CosyVoice)',
    async () => {
      const hasCosyVoice = await isEngineRegistered(server, 'cosyvoice-tts')
      if (!hasCosyVoice) {
        console.log('Skipping mixed engine generateJson test: REGISTER_COSYVOICE not set')
        return
      }
      const addr = server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/tts/generateJson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            {
              text: 'Hello world, this is the narrator speaking in English.',
              voice: 'en-US-AriaNeural',
              engine: 'edge-tts',
            },
            {
              text: '你好世界，我是女主角龙小春在说中文。',
              voice: 'longxiaochun',
              engine: 'cosyvoice-tts',
            },
          ],
        }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type') || '').toContain('application/octet-stream')
      expect(res.headers.get('x-generate-tts-type')).toBe('stream')
    },
    TTS_TIMEOUT
  )

  it(
    'POST /generateJson falls back to default engine when segment has no engine field',
    async () => {
      const res = await fetchJsonStream({
        data: [
          {
            text: 'This segment specifies engine.',
            voice: 'en-US-AriaNeural',
            engine: 'edge-tts',
          },
          {
            text: 'This segment has no engine, should default to edge-tts.',
            voice: 'en-US-JennyNeural',
          },
        ],
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type') || '').toContain('application/octet-stream')
    },
    TTS_TIMEOUT
  )

  it('POST /generateJson rejects invalid engine in a segment', async () => {
    const { status, data } = await fetchFromServer(server, '/api/v1/tts/generateJson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          { text: 'Hello world.', voice: 'en-US-AriaNeural', engine: 'nonexistent-tts' },
        ],
      }),
    })
    expect(status).toBe(400)
    expect(data.success).toBe(false)
  })

  it('POST /generateJson rejects empty data array', async () => {
    const { status, data } = await fetchFromServer(server, '/api/v1/tts/generateJson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [] }),
    })
    expect(status).toBe(400)
    expect(data.success).toBe(false)
  })
})

describe('Ticket 02 — Backend Pipeline: engine routing through TtsPluginManager', () => {
  let server: http.Server

  beforeAll((done) => {
    server = createTestServer(false)
    server.listen(0, () => done())
  })

  afterAll((done) => {
    server.close(() => done())
  })

  describe('POST /api/v1/tts/generate (non-streaming)', () => {
    it(
      'returns audio URL with default engine (backward compat)',
      async () => {
        const { status, data } = await fetchFromServer(server, '/api/v1/tts/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'Hello world, this is a test of the text to speech engine routing.',
            voice: 'en-US-AriaNeural',
          }),
        })
        expect(status).toBe(200)
        expect(data.success).toBe(true)
        expect(data.data).toBeDefined()
        expect(data.data.audio).toBeDefined()
        expect(typeof data.data.audio).toBe('string')
        expect(data.data.audio.length).toBeGreaterThan(0)
        expect(data.data.srt).toBeDefined()
        expect(data.data.file).toBeDefined()
      },
      TTS_TIMEOUT
    )

    it(
      'returns audio URL with engine=edge-tts',
      async () => {
        const { status, data } = await fetchFromServer(server, '/api/v1/tts/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'Hello world, this is a test with explicit edge tts engine selection.',
            voice: 'en-US-AriaNeural',
            engine: 'edge-tts',
          }),
        })
        expect(status).toBe(200)
        expect(data.success).toBe(true)
        expect(data.data.audio).toBeDefined()
        expect(data.data.srt).toBeDefined()
      },
      TTS_TIMEOUT
    )

    it(
      'returns audio URL with engine=cosyvoice-tts when registered',
      async () => {
        const hasCosyVoice = await isEngineRegistered(server, 'cosyvoice-tts')
        if (!hasCosyVoice) {
          console.log('Skipping CosyVoice /generate test: REGISTER_COSYVOICE not set')
          return
        }
        const { status, data } = await fetchFromServer(server, '/api/v1/tts/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: '你好世界，这是一个测试语音合成引擎路由的文本。',
            voice: 'longxiaochun',
            engine: 'cosyvoice-tts',
          }),
        })
        expect(status).toBe(200)
        expect(data.success).toBe(true)
        expect(data.data.audio).toBeDefined()
        // CosyVoice does not support subtitles
        expect(data.data.srt).toBeDefined()
      },
      TTS_TIMEOUT
    )
  })

  describe('POST /api/v1/tts/createStream (streaming)', () => {
    it(
      'returns streaming MP3 with default engine (backward compat)',
      async () => {
        const res = await fetch(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/tts/createStream`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: 'Hello world, this is a streaming test with the default engine.',
              voice: 'en-US-AriaNeural',
            }),
          }
        )
        expect(res.status).toBe(200)
        // Streaming should return audio/octet-stream content type
        const contentType = res.headers.get('content-type') || ''
        expect(contentType).toContain('application/octet-stream')
        // Should have x-generate-tts-type header
        expect(res.headers.get('x-generate-tts-type')).toBe('stream')
      },
      TTS_TIMEOUT
    )

    it(
      'returns streaming MP3 with engine=edge-tts',
      async () => {
        const res = await fetch(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/tts/createStream`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: 'Hello world, this is a streaming test with explicit engine selection.',
              voice: 'en-US-AriaNeural',
              engine: 'edge-tts',
            }),
          }
        )
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type') || '').toContain('application/octet-stream')
        expect(res.headers.get('x-generate-tts-type')).toBe('stream')
      },
      TTS_TIMEOUT
    )

    it(
      'returns streaming MP3 with engine=cosyvoice-tts when registered',
      async () => {
        const hasCosyVoice = await isEngineRegistered(server, 'cosyvoice-tts')
        if (!hasCosyVoice) {
          console.log('Skipping CosyVoice /createStream test: REGISTER_COSYVOICE not set')
          return
        }
        const res = await fetch(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/tts/createStream`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: '你好世界，这是一个流式测试。',
              voice: 'longxiaochun',
              engine: 'cosyvoice-tts',
            }),
          }
        )
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type') || '').toContain('application/octet-stream')
        expect(res.headers.get('x-generate-tts-type')).toBe('stream')
      },
      TTS_TIMEOUT
    )
  })
})
