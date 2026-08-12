import http from 'http'
import { AddressInfo } from 'net'
import { createApp } from '../src/app'
import { DoubaoTtsEngine } from '../src/tts/engines/doubaoTts'

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

  async function get(path: string) {
    const address = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`)
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
})
