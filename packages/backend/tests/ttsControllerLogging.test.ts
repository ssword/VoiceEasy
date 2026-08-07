import { NextFunction, Request, Response } from 'express'
import { generateAudio } from '../src/controllers/tts.controller'
import { generateTTS } from '../src/services/tts.service'
import { logger } from '../src/utils/logger'

jest.mock('../src/services/tts.service', () => ({
  generateTTS: jest.fn(),
  ErrorMessages: {
    ENG_MODEL_INVALID_TEXT: 'English model cannot process non-English text',
  },
}))

jest.mock('../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

const source = 'PRIVATE_NON_STREAM_SOURCE'

function request() {
  return {
    body: {
      text: source,
      voice: 'fixture-voice',
      useLLM: true,
      engine: 'qwen-audio-tts',
      openaiModel: 'fixture-model',
    },
  } as Request
}

function response() {
  return {
    locals: { correlationId: 'request-non-stream' },
    json: jest.fn(),
  } as unknown as Response
}

describe('Ticket 03 — non-streaming diagnostic logging', () => {
  beforeEach(() => jest.clearAllMocks())

  it('captures actual Segment/retry counts on success without content', async () => {
    jest.mocked(generateTTS).mockImplementation(async (_params, _task, diagnostics) => {
      diagnostics!.segmentCount = 3
      diagnostics!.retryCount = 1
      return { audio: '/audio/fixture.mp3', srt: '' }
    })

    await generateAudio(request(), response(), jest.fn() as NextFunction)

    const logs = JSON.stringify(jest.mocked(logger.info).mock.calls)
    expect(logs).not.toContain(source)
    expect(logs).toContain('request-non-stream')
    expect(logs).toContain('qwen-audio-tts')
    expect(logs).toContain('fixture-model')
    expect(logs).toContain('"segmentCount":3')
    expect(logs).toContain('"retryCount":1')
    expect(logs).toContain('audioBytes')
    expect(logs).toContain('durationMs')
  })

  it('retains the safe diagnostic envelope on failure', async () => {
    jest.mocked(generateTTS).mockImplementation(async (_params, _task, diagnostics) => {
      diagnostics!.segmentCount = 2
      diagnostics!.retryCount = 2
      throw new Error(`failed for ${source} with sk-private`)
    })
    const next = jest.fn() as NextFunction

    await generateAudio(request(), response(), next)

    const logs = JSON.stringify(jest.mocked(logger.error).mock.calls)
    expect(logs).not.toContain(source)
    expect(logs).not.toContain('sk-private')
    expect(logs).toContain('request-non-stream')
    expect(logs).toContain('"segmentCount":2')
    expect(logs).toContain('"retryCount":2')
    expect(logs).toContain('audioBytes')
    expect(logs).toContain('durationMs')
    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })
})
