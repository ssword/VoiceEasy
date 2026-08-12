import http from 'http'
import { AddressInfo } from 'net'
import { createApp } from '../src/app'
import { DoubaoTtsEngine } from '../src/tts/engines/doubaoTts'
import { resolveRecommendationVoices } from '../src/services/recommendationVoices'
import { fetcher } from '../src/utils/request'

jest.mock('../src/utils/request', () => ({
  fetcher: { post: jest.fn() },
}))

jest.mock('../src/services/buildSegmentAssembly.service', () => ({
  assembleBuildSegmentAudio: jest.fn(async () => undefined),
  assembleBuildSegmentSubtitles: jest.fn(async () => undefined),
}))

jest.mock('franc', () => ({
  franc: jest.fn(() => 'cmn'),
}))

const mp3 = Buffer.from('ID3-deterministic-doubao-api-audio').toString('base64')
const runId = `${process.pid}-${Date.now()}`

describe('Doubao Engine API discovery', () => {
  let server: http.Server

  beforeAll((done) => {
    const app = createApp({
      isDev: true,
      rateLimit: 1e6,
      rateLimitWindow: 10,
      audioDir: '/tmp/easyvoice-doubao-test-audio',
      publicDir: '/tmp/easyvoice-doubao-test-public',
      engines: [
        new DoubaoTtsEngine({
          apiKey: 'private-doubao-key',
          resourceId: 'seed-tts-resource',
          model: 'seed-audio-1.0',
        }),
      ],
    })
    server = http.createServer(app)
    server.listen(0, '127.0.0.1', done)
  })

  afterAll((done) => {
    server.close(() => done())
  })

  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(fetcher.post).mockResolvedValue({ data: { code: 0, audio: mp3 } } as any)
  })

  async function get(path: string) {
    const address = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`)
    return { status: response.status, data: await response.json() }
  }

  async function post(path: string, body: unknown) {
    const address = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, data: await response.json() }
  }

  it('exposes Doubao through /engines with subtitle support disabled', async () => {
    const { status, data } = await get('/api/v1/tts/engines')
    expect(status).toBe(200)
    expect(data.data).toEqual([
      expect.objectContaining({
        name: 'doubao-tts',
        languages: expect.arrayContaining(['zh-CN', 'en-US']),
        supportsSubtitles: false,
        voices: [expect.objectContaining({ Name: 'zh_female_tianmeitaozi_mars_bigtts' })],
      }),
    ])
    expect(JSON.stringify(data)).not.toContain('private-doubao-key')
    expect(JSON.stringify(data)).not.toContain('seed-tts-resource')
  })

  it('returns only Doubao Voices from the selected Voice List', async () => {
    const { status, data } = await get('/api/v1/tts/voiceList?engine=doubao-tts')
    expect(status).toBe(200)
    expect(data.data).toEqual([
      expect.objectContaining({
        Name: 'zh_female_tianmeitaozi_mars_bigtts',
        Gender: 'Female',
        language: 'zh-CN',
      }),
    ])
  })

  it('uses the registered Doubao Voice List for LLM Recommendation', async () => {
    await expect(resolveRecommendationVoices('doubao-tts', [])).resolves.toContainEqual(
      expect.objectContaining({ Name: 'zh_female_tianmeitaozi_mars_bigtts' })
    )
  })

  it('generates normal audio through the selected Doubao Engine', async () => {
    const { status, data } = await post('/api/v1/tts/generate', {
      text: `这是豆包普通生成接口测试，运行编号${runId}。`,
      voice: 'zh_female_tianmeitaozi_mars_bigtts',
      engine: 'doubao-tts',
    })

    expect(status).toBe(200)
    expect(data).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ srt: '' }),
      })
    )
    expect(fetcher.post).toHaveBeenCalledTimes(1)
  })

  it('splits long-form tasks before calling the Doubao Engine', async () => {
    const text = `这是一个需要拆分的豆包长文本句子，运行编号${runId}。`.repeat(200)
    const { status, data } = await post('/api/v1/tts/create', {
      text,
      voice: 'zh_female_tianmeitaozi_mars_bigtts',
      engine: 'doubao-tts',
    })
    expect(status).toBe(200)

    const taskId = data.data.id as string
    for (let attempt = 0; attempt < 100; attempt++) {
      const task = await get(`/api/v1/tts/task/${taskId}`)
      if (task.data.data.status !== 'pending') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const calls = jest.mocked(fetcher.post).mock.calls
    expect(calls.length).toBeGreaterThan(1)
    for (const [, request] of calls) {
      expect((request as { text_prompt: string }).text_prompt.length).toBeLessThanOrEqual(3000)
    }
  })
})
