import http from 'http'
import { AddressInfo } from 'net'
import { createApp } from '../src/app'
import { AUDIO_DIR, PUBLIC_DIR } from '../src/config'
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

describe('Ticket 03 — HTTP request logging', () => {
  it('correlates requests without persisting query-string content', async () => {
    const server = http.createServer(
      createApp({
        isDev: true,
        rateLimit: 1e6,
        rateLimitWindow: 10,
        audioDir: AUDIO_DIR,
        publicDir: PUBLIC_DIR,
        engines: [],
      })
    )
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const port = (server.address() as AddressInfo).port
      const response = await fetch(
        `http://127.0.0.1:${port}/api/health?apiKey=PRIVATE_QUERY_KEY&text=PRIVATE_QUERY_TEXT`,
        { headers: { 'x-request-id': 'request-query-test' } }
      )
      await response.arrayBuffer()

      const logs = JSON.stringify(jest.mocked(logger.log).mock.calls)
      expect(response.headers.get('x-request-id')).toBe('request-query-test')
      expect(logs).toContain('request-query-test')
      expect(logs).not.toContain('PRIVATE_QUERY_KEY')
      expect(logs).not.toContain('PRIVATE_QUERY_TEXT')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
