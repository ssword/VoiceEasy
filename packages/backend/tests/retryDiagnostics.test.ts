import { safeRunWithRetry } from '../src/utils'

describe('Ticket 03 — retry diagnostics', () => {
  it('counts retries, excluding the terminal failed attempt', async () => {
    const retriedAfterAttempts: number[] = []

    await expect(
      safeRunWithRetry(
        async () => {
          throw new Error('deterministic failure')
        },
        {
          retries: 3,
          baseDelayMs: 0,
          onError: jest.fn(),
          onRetry: (failedAttempt) => retriedAfterAttempts.push(failedAttempt),
        }
      )
    ).rejects.toThrow('deterministic failure')

    expect(retriedAfterAttempts).toEqual([1, 2])
  })
})
