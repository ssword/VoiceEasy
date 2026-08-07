import http from 'http'
import { AddressInfo } from 'net'
import { PassThrough, Readable } from 'stream'
import { createApp } from '../src/app'
import { AUDIO_DIR, PUBLIC_DIR } from '../src/config'
import { TTSEngine, TtsOptions } from '../src/tts/types'
import taskManager from '../src/utils/taskManager'
import { openai } from '../src/utils/openai'
import { logger } from '../src/utils/logger'

jest.mock('../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  },
}))

jest.mock('franc', () => ({
  franc: jest.fn(() => 'eng'),
}))

class ControlledEngine implements TTSEngine {
  readonly name = 'edge-tts'
  readonly supportsSubtitles = false
  readonly streams: PassThrough[] = []

  async synthesize(_text: string, options: TtsOptions): Promise<Buffer | Readable> {
    if (!options.stream) return Buffer.from('ID3-test-audio')
    const stream = new PassThrough()
    this.streams.push(stream)
    process.nextTick(() => stream.write(Buffer.from('ID3')))
    return stream
  }

  async getSupportedLanguages() {
    return ['en-US']
  }

  async getVoiceOptions() {
    return ['en-US-AriaNeural']
  }
}

function requestBody(change: Record<string, unknown> = {}) {
  return JSON.stringify({
    text: 'A deterministic duplicate streaming request.',
    voice: 'en-US-AriaNeural',
    engine: 'edge-tts',
    ...change,
  })
}

describe('Ticket 02 — streaming Task lifecycle', () => {
  let server: http.Server
  let engine: ControlledEngine
  let baseUrl: string

  beforeEach((done) => {
    jest.clearAllMocks()
    taskManager.tasks.clear()
    engine = new ControlledEngine()
    const app = createApp({
      isDev: true,
      rateLimit: 1e6,
      rateLimitWindow: 10,
      audioDir: AUDIO_DIR,
      publicDir: PUBLIC_DIR,
      engines: [engine],
    })
    server = http.createServer(app)
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      done()
    })
  })

  afterEach((done) => {
    for (const stream of engine.streams) stream.end()
    server.close(() => done())
    server.closeAllConnections()
  })

  it('returns 409 only while an identical request is pending, then accepts it again', async () => {
    const firstResponse = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(),
    })
    const taskId = firstResponse.headers.get('x-generate-tts-id')
    expect(taskId).toMatch(/^task/)

    const duplicateResponse = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(),
    })
    expect(duplicateResponse.status).toBe(409)
    await expect(duplicateResponse.json()).resolves.toEqual(
      expect.objectContaining({ success: false, code: 'TASK_ALREADY_PENDING' })
    )

    engine.streams[0].end()
    await firstResponse.arrayBuffer()
    expect(taskManager.getTask(taskId!)?.status).toBe('completed')
    const completedTask = taskManager.getTask(taskId!)!

    const repeatedResponsePromise = fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(),
    })
    await new Promise<void>((resolve) => {
      const check = () => (engine.streams.length === 2 ? resolve() : setImmediate(check))
      check()
    })
    taskManager.failTask(taskId!, { message: 'late callback from old stream' }, completedTask)
    expect(taskManager.getTask(taskId!)?.status).toBe('pending')
    engine.streams[1].end()
    const repeatedResponse = await repeatedResponsePromise
    expect(repeatedResponse.status).toBe(200)
    await repeatedResponse.arrayBuffer()
    expect(JSON.stringify(jest.mocked(logger.info).mock.calls)).toContain('"segmentCount":1')
  })

  it('marks an upstream stream error as failed and never overwrites that terminal state', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(),
    })
    const taskId = response.headers.get('x-generate-tts-id')
    expect(taskId).toMatch(/^task/)

    engine.streams[0].destroy(new Error('deterministic upstream failure'))
    await response.arrayBuffer().catch(() => undefined)

    expect(taskManager.getTask(taskId!)?.status).toBe('failed')
    taskManager.finishTask(taskId!)
    expect(taskManager.getTask(taskId!)?.status).toBe('failed')
  })

  it('marks a client disconnect as cancelled', async () => {
    const abortController = new AbortController()
    const response = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(),
      signal: abortController.signal,
    })
    const taskId = response.headers.get('x-generate-tts-id')
    expect(taskId).toMatch(/^task/)
    await response.body!.getReader().read()
    abortController.abort()

    await new Promise<void>((resolve) => {
      const check = () =>
        taskManager.getTask(taskId!)?.status !== 'pending' ? resolve() : setImmediate(check)
      check()
    })
    expect(taskManager.getTask(taskId!)?.status).toBe('cancelled')
  })

  it('keeps concurrent LLM Recommendation models in separate Tasks', async () => {
    jest.spyOn(openai, 'createChatCompletion').mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              segments: [
                {
                  name: 'en-US-AriaNeural',
                  text: 'Model-specific recommendation output.',
                  rate: '+0%',
                  pitch: '+0Hz',
                  volume: '+0%',
                },
              ],
            }),
          },
        },
      ],
    } as any)
    const llmBody = (openaiModel: string) =>
      requestBody({
        useLLM: true,
        openaiBaseUrl: 'https://llm.invalid/v1',
        openaiKey: 'test-key',
        openaiModel,
      })

    const firstResponse = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: llmBody('recommendation-model-a'),
    })
    const secondResponse = await fetch(`${baseUrl}/api/v1/tts/createStream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: llmBody('recommendation-model-b'),
    })

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-generate-tts-id')).not.toBe(
      firstResponse.headers.get('x-generate-tts-id')
    )
    engine.streams[0].end()
    engine.streams[1].end()
    await Promise.all([firstResponse.arrayBuffer(), secondResponse.arrayBuffer()])

    const logs = JSON.stringify(jest.mocked(logger.info).mock.calls)
    expect(logs).not.toContain('test-key')
    expect(logs).not.toContain('Model-specific recommendation output.')
    expect(logs).toContain('TTS stream completed')
    expect(logs).toContain('recommendation-model-a')
    expect(logs).toContain('segmentCount')
    expect(logs).toContain('durationMs')
    expect(logs).toContain('retryCount')
    expect(logs).toContain('audioBytes')
    expect(logs).toContain('generationMode')
    expect(logs).toContain('effectiveInterruptionCount')
    expect(logs).toContain('mixDurationMs')
  })

  it('completes a long-text LLM stream and accepts the identical content again', async () => {
    jest.spyOn(openai, 'createChatCompletion').mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              segments: [
                {
                  name: 'en-US-AriaNeural',
                  text: 'Deterministic LLM audio segment.',
                  rate: '+0%',
                  pitch: '+0Hz',
                  volume: '+0%',
                },
              ],
            }),
          },
        },
      ],
    } as any)
    const body = requestBody({
      text: 'Long deterministic narration. '.repeat(30),
      useLLM: true,
      openaiBaseUrl: 'https://llm.invalid/v1',
      openaiKey: 'test-key',
      openaiModel: 'test-model',
    })

    const completeRequest = async (streamOffset: number) => {
      const responsePromise = fetch(`${baseUrl}/api/v1/tts/createStream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      for (let index = streamOffset; index < streamOffset + 2; index++) {
        await new Promise<void>((resolve) => {
          const check = () => (engine.streams[index] ? resolve() : setImmediate(check))
          check()
        })
        engine.streams[index].end()
      }
      const response = await responsePromise
      expect(response.status).toBe(200)
      await response.arrayBuffer()
      return response.headers.get('x-generate-tts-id')!
    }

    const firstTaskId = await completeRequest(0)
    expect(taskManager.getTask(firstTaskId)?.status).toBe('completed')
    const repeatedTaskId = await completeRequest(2)
    expect(repeatedTaskId).toBe(firstTaskId)
    expect(taskManager.getTask(repeatedTaskId)?.status).toBe('completed')
  })
})
