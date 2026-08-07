import { NextFunction, Request, Response } from 'express'
import { createTaskStream } from '../src/controllers/stream.controller'
import { generateTTSStream } from '../src/services/tts.stream.service'
import taskManager from '../src/utils/taskManager'

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

describe('createTaskStream', () => {
  it('forwards an asynchronous LLM failure instead of leaving an unhandled rejection', async () => {
    const failure = new Error('Chat completion request failed: stream has been aborted')
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
  })
})
