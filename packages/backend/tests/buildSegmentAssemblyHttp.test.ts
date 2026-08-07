import fs from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import { createApp } from '../src/app'
import { AUDIO_DIR, PUBLIC_DIR } from '../src/config'
import { TTSEngine, TtsOptions } from '../src/tts/types'
import { createStereoToneMp3, probeAudioDuration, probeStereoRms } from './helpers/audio'

jest.setTimeout(30_000)

jest.mock('franc', () => ({
  franc: jest.fn(() => 'eng'),
}))

jest.mock('../src/utils/openai', () => ({
  openai: {
    config: jest.fn(),
    createChatCompletion: jest.fn(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              segments: [
                { text: 'First recommended Segment.', name: 'en-US-AriaNeural' },
                {
                  text: 'Second recommended Segment.',
                  name: 'en-US-AriaNeural',
                  interrupt: true,
                  overlapMs: 400,
                  duckPreviousDb: -12,
                },
              ],
            }),
          },
        },
      ],
    })),
  },
}))

const longText = (label: string) => `${label} sentence for ordered audio assembly. `.repeat(20)
const recommendationText =
  `Recommend two voices for this deterministic interrupted dialogue ${process.pid}.`

describe('Issue #2 HTTP audio assembly regression', () => {
  let server: http.Server
  let baseUrl: string
  let firstFixture: Buffer
  let secondFixture: Buffer
  let fixtureDuration: number
  let probeDir: string

  beforeAll(async () => {
    probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-http-assembly-'))
    const firstFixturePath = path.join(probeDir, 'first-fixture.mp3')
    const secondFixturePath = path.join(probeDir, 'second-fixture.mp3')
    await Promise.all([
      createStereoToneMp3(firstFixturePath, 440, 1, 'left'),
      createStereoToneMp3(secondFixturePath, 880, 1, 'right'),
    ])
    firstFixture = await fs.readFile(firstFixturePath)
    secondFixture = await fs.readFile(secondFixturePath)
    fixtureDuration = await probeAudioDuration(firstFixturePath)

    class FixtureEngine implements TTSEngine {
      readonly name = 'edge-tts'
      readonly supportsSubtitles = false

      async synthesize(text: string, options: TtsOptions): Promise<Buffer | Readable> {
        const fixture = text.includes('Second') ? secondFixture : firstFixture
        return options.stream ? Readable.from([fixture]) : fixture
      }

      async getSupportedLanguages(): Promise<string[]> {
        return ['en-US']
      }

      async getVoiceOptions(): Promise<string[]> {
        return ['en-US-AriaNeural']
      }
    }

    const app = createApp({
      isDev: true,
      rateLimit: 1e6,
      rateLimitWindow: 10,
      audioDir: AUDIO_DIR,
      publicDir: PUBLIC_DIR,
      engines: [new FixtureEngine()],
    })
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(probeDir, { recursive: true, force: true })
  })

  async function expectPlayableMultiSegmentAudio(audio: ArrayBuffer, name: string) {
    const probeFile = path.join(probeDir, name)
    await fs.writeFile(probeFile, Buffer.from(audio))
    const duration = await probeAudioDuration(probeFile)
    expect(duration).toBeGreaterThan(fixtureDuration * 1.8)
  }

  it('preserves /generate JSON and playable Concat behavior for multiple Segments', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: recommendationText,
        voice: 'en-US-AriaNeural',
        useLLM: true,
        openaiBaseUrl: 'https://example.test/v1',
        openaiKey: 'fixture-key',
        openaiModel: 'fixture-model',
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json()
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        code: 200,
        data: expect.objectContaining({ audio: expect.any(String), file: expect.any(String) }),
      })
    )

    const audioResponse = await fetch(`${baseUrl}/${body.data.file}`)
    expect(audioResponse.status).toBe(200)
    expect(audioResponse.headers.get('content-type')).toBe('audio/mpeg')
    await expectPlayableMultiSegmentAudio(await audioResponse.arrayBuffer(), 'generate.mp3')
  })

  it('returns real overlapping and ducked tracks from /generate when enabled', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: recommendationText,
        voice: 'en-US-AriaNeural',
        useLLM: true,
        enableInterruptions: true,
        openaiBaseUrl: 'https://example.test/v1',
        openaiKey: 'fixture-key',
        openaiModel: 'fixture-model',
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    const audioResponse = await fetch(`${baseUrl}/${body.data.file}`)
    expect(audioResponse.status).toBe(200)
    const probeFile = path.join(probeDir, 'generate-timeline.mp3')
    await fs.writeFile(probeFile, Buffer.from(await audioResponse.arrayBuffer()))

    const duration = await probeAudioDuration(probeFile)
    expect(duration).toBeGreaterThan(fixtureDuration * 2 - 0.5)
    expect(duration).toBeLessThan(fixtureDuration * 2 - 0.3)
    const overlap = await probeStereoRms(probeFile, fixtureDuration - 0.3, 0.15)
    expect(overlap.left).toBeGreaterThan(0.005)
    expect(overlap.right).toBeGreaterThan(0.02)
    expect(overlap.left).toBeLessThan(overlap.right * 0.5)
  })

  it('preserves /createStream headers and playable ordered audio for multiple Segments', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: longText('Streaming'),
        voice: 'en-US-AriaNeural',
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/octet-stream')
    expect(response.headers.get('x-generate-tts-type')).toBe('stream')
    expect(response.headers.get('x-generate-tts-id')).toEqual(expect.any(String))
    expect(response.headers.get('access-control-expose-headers')).toContain('x-generate-tts-id')
    await expectPlayableMultiSegmentAudio(await response.arrayBuffer(), 'create-stream.mp3')
  })
})
