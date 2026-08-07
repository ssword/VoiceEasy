import { NextFunction, Request, Response } from 'express'
import { errorHandler } from '../src/middleware/error.middleware'
import { logger, redactSecrets } from '../src/utils/logger'

jest.mock('../src/utils/logger', () => {
  const actual = jest.requireActual('../src/utils/logger')
  return {
    ...actual,
    logger: { error: jest.fn() },
  }
})

jest.mock('../src/services/tts.service', () => ({
  ErrorMessages: {
    ENG_MODEL_INVALID_TEXT: 'English model cannot process non-English text',
  },
}))

describe('errorHandler logging', () => {
  it('summarizes binary values instead of expanding their bytes', () => {
    expect(redactSecrets(Buffer.from([0x49, 0x44, 0x33]))).toBe('[Buffer 3 bytes]')
  })

  it('defensively redacts content fields and Error messages', () => {
    const redacted = redactSecrets({
      text: 'PRIVATE_SOURCE_TEXT',
      prompt: 'PRIVATE_PROMPT',
      segments: [{ text: 'PRIVATE_SEGMENT' }],
      error: new Error('PRIVATE_ERROR_MESSAGE'),
    })

    expect(JSON.stringify(redacted)).not.toMatch(
      /PRIVATE_SOURCE_TEXT|PRIVATE_PROMPT|PRIVATE_SEGMENT|PRIVATE_ERROR_MESSAGE/
    )
  })

  it('logs only safe request and error metadata', () => {
    const req = {
      method: 'POST',
      url: '/api/v1/tts/createStream',
      headers: {
        authorization: 'Bearer header-secret',
        cookie: 'session=secret',
      },
      body: {
        text: '医生：您好',
        openaiKey: 'llm-secret',
        nested: { accessToken: 'nested-secret' },
      },
      query: {},
      params: {},
      ip: '::1',
    } as unknown as Request
    const json = jest.fn()
    const res = {
      status: jest.fn(() => ({ json })),
    } as unknown as Response

    errorHandler(new Error('LLM failed'), req, res, jest.fn() as NextFunction)

    const logged = JSON.stringify(jest.mocked(logger.error).mock.calls[0])
    expect(logged).not.toContain('医生：您好')
    expect(logged).not.toContain('llm-secret')
    expect(logged).not.toContain('header-secret')
    expect(logged).not.toContain('nested-secret')
    expect(logged).toContain('POST')
    expect(logged).toContain('textLength')
    expect(logged).toContain('textHash')
    expect(logged).toContain('Error')
  })
})
