import fs from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import { createApp } from '../src/app'
import { AUDIO_DIR, PUBLIC_DIR } from '../src/config'
import { normalizeTtsRequest } from '../src/services/ttsRequest'
import * as textService from '../src/services/text.service'
import { TTSEngine, TtsOptions } from '../src/tts/types'
import taskManager from '../src/utils/taskManager'
import { createStereoToneMp3, probeAudioDuration, probeStereoRms } from './helpers/audio'

jest.setTimeout(30_000)

jest.mock('franc', () => ({
  franc: jest.fn(() => 'eng'),
}))

const mockPipelineEvents: string[] = []
const mockRunId = Date.now()
let mockCancelStreamStarted: (() => void) | undefined
let mockCancelStreamDestroyed = false
let mockOverlapMs = 400
let mockDuckPreviousDb = -12

jest.mock('../src/utils/openai', () => ({
  openai: {
    config: jest.fn(),
    createChatCompletion: jest.fn(async (request: any) => {
      const prompt = String(request.messages?.at(-1)?.content || '')
      mockPipelineEvents.push(
        `recommend:${prompt.includes('SECOND_BATCH') ? 'second' : 'first'}`
      )
      const segments = prompt.includes('CANCEL_MIX')
        ? [
            { text: 'Mix cancellation first Segment.', name: 'en-US-AriaNeural' },
            {
              text: 'Mix cancellation second Segment.',
              name: 'en-US-AriaNeural',
              interrupt: true,
              overlapMs: 400,
              duckPreviousDb: -12,
            },
          ]
        : prompt.includes('CANCEL_BUFFERING')
        ? [
            { text: 'Cancelled first Segment.', name: 'en-US-AriaNeural' },
            {
              text: 'Cancelled second Segment.',
              name: 'en-US-AriaNeural',
              interrupt: true,
              overlapMs: 400,
              duckPreviousDb: -12,
            },
          ]
        : prompt.includes('FIRST_BATCH')
        ? [
            { text: 'First cross-batch Segment.', name: 'en-US-AriaNeural' },
            {
              text: 'Second cross-batch Segment.',
              name: 'en-US-AriaNeural',
              interrupt: true,
              overlapMs: 200,
              duckPreviousDb: -8,
            },
          ]
        : prompt.includes('SECOND_BATCH')
        ? [
            {
              text: 'Third cross-batch Segment.',
              name: 'en-US-AriaNeural',
              interrupt: true,
              overlapMs: 400,
              duckPreviousDb: -10,
            },
            {
              text: 'Fourth cross-batch Segment.',
              name: 'en-US-AriaNeural',
              interrupt: true,
              overlapMs: 300,
              duckPreviousDb: -12,
            },
          ]
        : prompt.includes('NO_OVERLAP')
        ? [{ text: 'Serial recommended Segment.', name: 'en-US-AriaNeural' }]
        : [
            { text: 'First recommended Segment.', name: 'en-US-AriaNeural' },
            {
              text: 'Second recommended Segment.',
              name: 'en-US-AriaNeural',
              interrupt: true,
              overlapMs: mockOverlapMs,
              duckPreviousDb: mockDuckPreviousDb,
            },
          ]
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                segments: segments.map((segment) => ({
                  ...segment,
                  text: `${segment.text} ${mockRunId}`,
                })),
              }),
            },
          },
        ],
      }
    }),
  },
}))

const longText = (label: string) => `${label} sentence for ordered audio assembly. `.repeat(20)
const recommendationText =
  `Recommend two voices for this deterministic interrupted dialogue ${process.pid}.`
const crossBatchText =
  `FIRST_BATCH ${'first batch words '.repeat(24)}. ` +
  `SECOND_BATCH ${'second batch words '.repeat(24)}.`
const noOverlapText =
  `NO_OVERLAP first ${'serial first words '.repeat(24)}. ` +
  `NO_OVERLAP second ${'serial second words '.repeat(24)}.`

describe('Issue #2 HTTP audio assembly regression', () => {
  let server: http.Server
  let baseUrl: string
  let firstFixture: Buffer
  let secondFixture: Buffer
  let fixtureDuration: number
  let longFixture: Buffer
  let probeDir: string

  beforeAll(async () => {
    probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-http-assembly-'))
    const firstFixturePath = path.join(probeDir, 'first-fixture.mp3')
    const secondFixturePath = path.join(probeDir, 'second-fixture.mp3')
    const longFixturePath = path.join(probeDir, 'long-fixture.mp3')
    await Promise.all([
      createStereoToneMp3(firstFixturePath, 440, 1, 'left'),
      createStereoToneMp3(secondFixturePath, 880, 1, 'right'),
      createStereoToneMp3(longFixturePath, 660, 300, 'left'),
    ])
    firstFixture = await fs.readFile(firstFixturePath)
    secondFixture = await fs.readFile(secondFixturePath)
    longFixture = await fs.readFile(longFixturePath)
    fixtureDuration = await probeAudioDuration(firstFixturePath)

    class FixtureEngine implements TTSEngine {
      readonly name: string = 'edge-tts'
      readonly supportsSubtitles: boolean = true

      async synthesize(text: string, options: TtsOptions): Promise<Buffer | Readable> {
        mockPipelineEvents.push(`synthesize:${text}`)
        if (options.saveSubtitles && options.output) {
          const subtitle = JSON.stringify([
            {
              part: text.includes('Second') ? 'Role B: second' : 'Role A: first',
              start: 0,
              end: 900,
            },
          ])
          if (options.stream) {
            const subtitleDir = `${options.output}_tmp`
            await fs.mkdir(subtitleDir, { recursive: true })
            await fs.writeFile(
              path.join(subtitleDir, `${path.basename(options.output)}.srt.json`),
              subtitle
            )
          } else {
            await fs.writeFile(`${options.output}.json`, subtitle)
          }
        }
        if (text.includes('Cancelled')) {
          let timer: NodeJS.Timeout | undefined
          return new Readable({
            read() {
              mockCancelStreamStarted?.()
              timer = setTimeout(() => {
                this.push(firstFixture)
                this.push(null)
              }, 250)
            },
            destroy(error, callback) {
              if (timer) clearTimeout(timer)
              mockCancelStreamDestroyed = true
              callback(error)
            },
          })
        }
        if (text.includes('Mix cancellation')) {
          return options.stream ? Readable.from([longFixture]) : longFixture
        }
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

    class NoSubtitleFixtureEngine extends FixtureEngine {
      readonly name = 'no-subtitles'
      readonly supportsSubtitles = false
    }

    const app = createApp({
      isDev: true,
      rateLimit: 1e6,
      rateLimitWindow: 10,
      audioDir: AUDIO_DIR,
      publicDir: PUBLIC_DIR,
      engines: [new FixtureEngine(), new NoSubtitleFixtureEngine()],
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
        data: expect.objectContaining({
          audio: expect.any(String),
          file: expect.any(String),
          srt: expect.any(String),
        }),
      })
    )

    const audioResponse = await fetch(`${baseUrl}/${body.data.file}`)
    expect(audioResponse.status).toBe(200)
    expect(audioResponse.headers.get('content-type')).toBe('audio/mpeg')
    await expectPlayableMultiSegmentAudio(await audioResponse.arrayBuffer(), 'generate.mp3')
  })

  it('returns an empty subtitle result for an Engine without subtitle capability', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${recommendationText} no subtitle engine`,
        voice: 'en-US-AriaNeural',
        engine: 'no-subtitles',
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.srt).toBe('')
  })

  it('returns real overlapping and ducked tracks from /generate when enabled', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${recommendationText} create-stream timeline`,
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

    const subtitleResponse = await fetch(`${baseUrl}/${path.basename(body.data.srt)}`)
    expect(subtitleResponse.status).toBe(200)
    const subtitles = await subtitleResponse.text()
    expect(subtitles).toContain('Role A: first')
    expect(subtitles).toContain('Role B: second')
    const cueStarts = [...subtitles.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) -->/g)].map(
      (match) =>
        Number(match[1]) * 3600 +
        Number(match[2]) * 60 +
        Number(match[3]) +
        Number(match[4]) / 1000
    )
    expect(cueStarts[0]).toBe(0)
    expect(cueStarts[1]).toBeGreaterThan(0.55)
    expect(cueStarts[1]).toBeLessThan(0.7)
    expect(cueStarts[1]).toBeLessThan(0.9)
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

  it('returns a playable buffered Timeline Mix from /createStream for an interrupted batch', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
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
    expect(response.headers.get('content-type')).toContain('audio/mpeg')
    expect(response.headers.get('x-generate-tts-type')).toBe('buffered-timeline')
    expect(response.headers.get('x-generate-tts-id')).toEqual(expect.any(String))
    expect(response.headers.get('access-control-expose-headers')).toContain(
      'x-generate-tts-type'
    )

    const probeFile = path.join(probeDir, 'create-stream-timeline.mp3')
    await fs.writeFile(probeFile, Buffer.from(await response.arrayBuffer()))
    const duration = await probeAudioDuration(probeFile)
    expect(duration).toBeGreaterThan(fixtureDuration * 2 - 0.5)
    expect(duration).toBeLessThan(fixtureDuration * 2 - 0.3)
    const overlap = await probeStereoRms(probeFile, fixtureDuration - 0.3, 0.15)
    expect(overlap.left).toBeGreaterThan(0.005)
    expect(overlap.right).toBeGreaterThan(0.02)
    expect(overlap.left).toBeLessThan(overlap.right * 0.5)
  })

  it('keeps consecutive interruptions across LLM batch boundaries on one global timeline', async () => {
    mockPipelineEvents.length = 0
    const response = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: crossBatchText,
        voice: 'en-US-AriaNeural',
        useLLM: true,
        enableInterruptions: true,
        openaiBaseUrl: 'https://example.test/v1',
        openaiKey: 'fixture-key',
        openaiModel: 'fixture-model',
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-generate-tts-type')).toBe('buffered-timeline')
    const probeFile = path.join(probeDir, 'create-stream-cross-batch.mp3')
    await fs.writeFile(probeFile, Buffer.from(await response.arrayBuffer()))
    const duration = await probeAudioDuration(probeFile)
    expect(duration).toBeGreaterThan(fixtureDuration * 4 - 1)
    expect(duration).toBeLessThan(fixtureDuration * 4 - 0.8)
    const firstSynthesis = mockPipelineEvents.findIndex((event) => event.startsWith('synthesize:'))
    expect(mockPipelineEvents.slice(0, firstSynthesis)).toEqual([
      'recommend:first',
      'recommend:second',
    ])
  })

  it('retains Segment Streaming when interruption metadata has no effective overlap', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: noOverlapText,
        voice: 'en-US-AriaNeural',
        useLLM: true,
        enableInterruptions: true,
        openaiBaseUrl: 'https://example.test/v1',
        openaiKey: 'fixture-key',
        openaiModel: 'fixture-model',
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/octet-stream')
    expect(response.headers.get('x-generate-tts-type')).toBe('stream')
    const probeFile = path.join(probeDir, 'create-stream-no-overlap.mp3')
    await fs.writeFile(probeFile, Buffer.from(await response.arrayBuffer()))
    const duration = await probeAudioDuration(probeFile)
    expect(duration).toBeGreaterThan(fixtureDuration * 1.8)
  })

  it('cancels buffered Segment generation and removes temporary files after disconnect', async () => {
    mockCancelStreamDestroyed = false
    const synthesisStarted = new Promise<void>((resolve) => {
      mockCancelStreamStarted = resolve
    })
    const request = {
      text: `CANCEL_BUFFERING ${process.pid}`,
      voice: 'en-US-AriaNeural',
      useLLM: true,
      enableInterruptions: true,
      openaiBaseUrl: 'https://example.test/v1',
      openaiKey: 'fixture-key',
      openaiModel: 'fixture-model',
    }
    const taskId = taskManager.generateTaskId(normalizeTtsRequest(request))
    const before = new Set(await fs.readdir(AUDIO_DIR))
    const abortController = new AbortController()
    const pendingResponse = fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: abortController.signal,
    })

    await synthesisStarted
    abortController.abort()
    await expect(pendingResponse).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const taskResponse = await fetch(`${baseUrl}/api/v1/tts/task/${taskId}`)
    expect(taskResponse.status).toBe(200)
    const taskBody = await taskResponse.json()
    expect(taskBody.data).toEqual(
      expect.objectContaining({ status: 'cancelled', message: 'Client disconnected' })
    )
    expect(mockCancelStreamDestroyed).toBe(true)
    const after = (await fs.readdir(AUDIO_DIR)).filter((entry) => !before.has(entry))
    expect(after).toEqual([])
  })

  it('cancels Timeline Mix and removes its process files after disconnect', async () => {
    const request = {
      text: `CANCEL_MIX ${process.pid}`,
      voice: 'en-US-AriaNeural',
      useLLM: true,
      enableInterruptions: true,
      openaiBaseUrl: 'https://example.test/v1',
      openaiKey: 'fixture-key',
      openaiModel: 'fixture-model',
    }
    const before = new Set(await fs.readdir(AUDIO_DIR))
    const abortController = new AbortController()
    const response = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: abortController.signal,
    })
    const taskId = response.headers.get('x-generate-tts-id')
    expect(response.headers.get('x-generate-tts-type')).toBe('buffered-timeline')
    expect(taskId).toEqual(expect.any(String))

    abortController.abort()
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const taskResponse = await fetch(`${baseUrl}/api/v1/tts/task/${taskId}`)
    const taskBody = await taskResponse.json()
    expect(taskBody.data).toEqual(expect.objectContaining({ status: 'cancelled' }))
    const after = (await fs.readdir(AUDIO_DIR)).filter((entry) => !before.has(entry))
    expect(after).toEqual([])
  })

  it('matches /generate duration and overlap behavior for the same Build Segment timeline', async () => {
    const realSplitText = textService.splitText
    const splitText = jest.spyOn(textService, 'splitText').mockImplementation((text, targetLength) =>
      text.includes('Consistent interrupted timeline')
        ? { length: 2, segments: ['FIRST_BATCH first.', 'SECOND_BATCH second.'] }
        : realSplitText(text, targetLength)
    )
    const request = {
      text: `Consistent interrupted timeline ${process.pid} ${Date.now()}.`,
      voice: 'en-US-AriaNeural',
      useLLM: true,
      enableInterruptions: true,
      openaiBaseUrl: 'https://example.test/v1',
      openaiKey: 'fixture-key',
      openaiModel: 'fixture-model',
    }
    try {
      const streamResponse = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const streamFile = path.join(probeDir, 'consistent-create-stream.mp3')
      await fs.writeFile(streamFile, Buffer.from(await streamResponse.arrayBuffer()))

      const generateResponse = await fetch(`${baseUrl}/api/v1/tts/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const generateBody = await generateResponse.json()
      const generatedAudio = await fetch(`${baseUrl}/${generateBody.data.file}`)
      const generateFile = path.join(probeDir, 'consistent-generate.mp3')
      await fs.writeFile(generateFile, Buffer.from(await generatedAudio.arrayBuffer()))

      const [streamDuration, generateDuration] = await Promise.all([
        probeAudioDuration(streamFile),
        probeAudioDuration(generateFile),
      ])
      expect(Math.abs(streamDuration - generateDuration)).toBeLessThan(0.05)
      const [streamOverlap, generateOverlap] = await Promise.all([
        probeStereoRms(streamFile, fixtureDuration - 0.1, 0.1),
        probeStereoRms(generateFile, fixtureDuration - 0.1, 0.1),
      ])
      expect(streamOverlap.left).toBeCloseTo(generateOverlap.left, 2)
      expect(streamOverlap.right).toBeCloseTo(generateOverlap.right, 2)
    } finally {
      splitText.mockRestore()
    }
  })

  it('isolates /generate final cache by timeline while reusing Segment synthesis', async () => {
    const text = `Timeline cache isolation ${process.pid} ${Date.now()}.`
    const request = {
      text,
      voice: 'en-US-AriaNeural',
      useLLM: true,
      enableInterruptions: true,
      openaiBaseUrl: 'https://example.test/v1',
      openaiKey: 'fixture-key',
      openaiModel: 'fixture-model',
    }
    mockOverlapMs = 200
    mockDuckPreviousDb = -8
    const firstResponse = await fetch(`${baseUrl}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    const firstBody = await firstResponse.json()
    const synthesesAfterFirst = mockPipelineEvents.filter((event) =>
      event.startsWith('synthesize:')
    ).length

    mockOverlapMs = 600
    mockDuckPreviousDb = -14
    const secondResponse = await fetch(`${baseUrl}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    const secondBody = await secondResponse.json()

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondBody.data.file).not.toBe(firstBody.data.file)
    expect(
      mockPipelineEvents.filter((event) => event.startsWith('synthesize:')).length
    ).toBe(synthesesAfterFirst)

    mockOverlapMs = 400
    mockDuckPreviousDb = -12
  })

  it('isolates /createStream final cache by timeline while reusing Segment synthesis', async () => {
    const request = {
      text: `Streaming timeline cache isolation ${process.pid} ${Date.now()}.`,
      voice: 'en-US-AriaNeural',
      useLLM: true,
      enableInterruptions: true,
      openaiBaseUrl: 'https://example.test/v1',
      openaiKey: 'fixture-key',
      openaiModel: 'fixture-model',
    }

    mockOverlapMs = 200
    mockDuckPreviousDb = -8
    const firstResponse = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    const firstAudio = await firstResponse.arrayBuffer()
    const synthesesAfterFirst = mockPipelineEvents.filter((event) =>
      event.startsWith('synthesize:')
    ).length

    mockOverlapMs = 600
    mockDuckPreviousDb = -14
    const secondResponse = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    const secondAudio = await secondResponse.arrayBuffer()

    expect(firstResponse.headers.get('x-generate-tts-type')).toBe('buffered-timeline')
    expect(secondResponse.headers.get('x-generate-tts-type')).toBe('buffered-timeline')
    expect(
      mockPipelineEvents.filter((event) => event.startsWith('synthesize:')).length
    ).toBe(synthesesAfterFirst)
    const firstFile = path.join(probeDir, 'stream-cache-first.mp3')
    const secondFile = path.join(probeDir, 'stream-cache-second.mp3')
    await Promise.all([
      fs.writeFile(firstFile, Buffer.from(firstAudio)),
      fs.writeFile(secondFile, Buffer.from(secondAudio)),
    ])
    expect(await probeAudioDuration(secondFile)).toBeLessThan(
      await probeAudioDuration(firstFile)
    )

    mockOverlapMs = 400
    mockDuckPreviousDb = -12
  })
})
