import { NextFunction, Request, Response } from 'express'
import { createTaskStream } from '../src/controllers/stream.controller'
import { generateTTSStream } from '../src/services/tts.stream.service'
import taskManager from '../src/utils/taskManager'
import { logger } from '../src/utils/logger'

jest.mock('../src/services/tts.stream.service', () => ({
  generateTTSStream: jest.fn(),
  generateTTSStreamJson: jest.fn(),
}))

jest.mock('../src/utils/taskManager', () => ({
  __esModule: true,
  default: {
    createTask: jest.fn(() => ({ id: 'task-test' })),
    failTask: jest.fn(),
  },
}))

jest.mock('../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}))

describe('createTaskStream', () => {
  beforeEach(() => jest.clearAllMocks())

  it('logs safe correlation and request diagnostics on the accepted path', async () => {
    jest.mocked(generateTTSStream).mockResolvedValue(undefined)
    const req = {
      body: {
        text: 'PRIVATE_SOURCE_TEXT',
        voice: 'fixture-voice',
        useLLM: true,
        engine: 'qwen-audio-tts',
        openaiModel: 'fixture-model',
      },
      query: {},
    } as unknown as Request
    const res = { locals: { correlationId: 'request-123' } } as unknown as Response

    await createTaskStream(req, res, jest.fn() as NextFunction)

    const logs = JSON.stringify(jest.mocked(logger.info).mock.calls)
    expect(logs).not.toContain('PRIVATE_SOURCE_TEXT')
    expect(logs).toContain('request-123')
    expect(logs).toContain('qwen-audio-tts')
    expect(logs).toContain('fixture-model')
    expect(logs).toContain('textLength')
    expect(logs).toContain('textHash')
    expect(logs).toContain('segmentCount')
    expect(logs).toContain('retryCount')
  })

  it('forwards an asynchronous LLM failure instead of leaving an unhandled rejection', async () => {
    const failure = new Error('Chat completion failed for PRIVATE_SOURCE_TEXT using sk-private')
    const rejected = Promise.reject(failure)
    rejected.catch(() => undefined)
    jest.mocked(generateTTSStream).mockReturnValue(rejected)

    const req = {
      body: {
        text: 'hello',
        voice: 'en-US-AriaNeural',
        useLLM: true,
        engine: 'edge-tts',
      },
      query: {},
    } as unknown as Request
    const res = {} as Response
    const next = jest.fn() as NextFunction

    await createTaskStream(req, res, next)

    expect(taskManager.failTask).toHaveBeenCalledWith('task-test', {
      message: failure.message,
    }, expect.objectContaining({ id: 'task-test' }))
    expect(next).toHaveBeenCalledWith(failure)
    const logs = JSON.stringify(jest.mocked(logger.error).mock.calls)
    expect(logs).not.toContain('PRIVATE_SOURCE_TEXT')
    expect(logs).not.toContain('sk-private')
    expect(logs).toContain('Error')
    expect(logs).toContain('correlationId')
    expect(logs).toContain('engine')
    expect(logs).toContain('model')
    expect(logs).toContain('textLength')
    expect(logs).toContain('textHash')
    expect(logs).toContain('segmentCount')
    expect(logs).toContain('durationMs')
    expect(logs).toContain('retryCount')
    expect(logs).toContain('audioBytes')
  })
})
