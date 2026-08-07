import fs from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import { createApp } from '../src/app'
import { AUDIO_DIR, PUBLIC_DIR } from '../src/config'
import { TTSEngine, TtsOptions } from '../src/tts/types'

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
                { text: 'Second recommended Segment.', name: 'en-US-AriaNeural' },
              ],
            }),
          },
        },
      ],
    })),
  },
}))

const fixturePath = path.resolve(__dirname, '../../frontend/src/assets/notification.mp3')
const longText = (label: string) => `${label} sentence for ordered audio assembly. `.repeat(20)

async function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `ffprobe exited with ${code}`))
      resolve(Number(stdout.trim()))
    })
  })
}

describe('Issue #2 HTTP audio assembly regression', () => {
  let server: http.Server
  let baseUrl: string
  let fixture: Buffer
  let fixtureDuration: number
  let probeDir: string

  beforeAll(async () => {
    fixture = await fs.readFile(fixturePath)
    fixtureDuration = await probeDuration(fixturePath)
    probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-http-assembly-'))

    class FixtureEngine implements TTSEngine {
      readonly name = 'edge-tts'
      readonly supportsSubtitles = false

      async synthesize(_text: string, options: TtsOptions): Promise<Buffer | Readable> {
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
    const duration = await probeDuration(probeFile)
    expect(duration).toBeGreaterThan(fixtureDuration * 1.8)
  }

  it('preserves /generate JSON and playable Concat behavior for multiple Segments', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Recommend two voices for this deterministic dialogue ${process.pid}.`,
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
