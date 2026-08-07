import { createOpenAIClient } from '../src/utils/openai'
import { fetcher } from '../src/utils/request'

jest.mock('../src/utils/request', () => ({
  fetcher: {
    post: jest.fn(),
    get: jest.fn(),
  },
}))

jest.mock('../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}))

describe('OpenAI-compatible client', () => {
  it('allows slow LLM recommendations for up to 120 seconds by default', async () => {
    jest.mocked(fetcher.post).mockResolvedValue({
      data: {
        choices: [{ message: { content: '{"segments":[]}' } }],
        usage: { total_tokens: 1 },
      },
    } as any)
    const client = createOpenAIClient()
    client.config({
      baseURL: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
    })

    await client.createChatCompletion({
      messages: [{ role: 'user', content: '测试' }],
    })

    expect(fetcher.post).toHaveBeenCalledWith(
      'https://example.test/chat/completions',
      expect.any(Object),
      expect.objectContaining({ timeout: 120_000 })
    )
  })
})
