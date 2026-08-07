import { PassThrough } from 'stream'
import { Response } from 'express'
import { streamToResponse } from '../src/utils'
import { logger } from '../src/utils/logger'

jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

describe('streamToResponse error logging', () => {
  it('logs an input stream error without serializing its attached binary response', () => {
    const input = new PassThrough()
    const output = new PassThrough() as PassThrough & Partial<Response>
    output.setHeader = jest.fn()
    output.status = jest.fn(() => output as unknown as Response)

    streamToResponse(output as unknown as Response, input)

    const error = Object.assign(new Error('TTS request failed'), {
      response: {
        data: Buffer.from([0x49, 0x44, 0x33]),
      },
    })
    input.emit('error', error)

    expect(output.status).toHaveBeenCalledWith(500)
    expect(logger.error).toHaveBeenCalledWith('Input stream error', {
      error: { name: 'Error' },
    })
    expect(logger.error).not.toHaveBeenCalledWith(expect.anything(), error)

    output.destroy()
  })
})
