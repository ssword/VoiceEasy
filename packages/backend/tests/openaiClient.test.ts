import { createOpenAIClient } from '../src/utils/openai'
import { fetcher } from '../src/utils/request'
import { logger } from '../src/utils/logger'

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

  it('records model and size metadata without Prompt or completion content', async () => {
    const source = 'PRIVATE_SOURCE_TEXT 医疗对话'
    const completion = '{"segments":[{"text":"PRIVATE_LLM_SEGMENT"}]}'
    jest.mocked(fetcher.post).mockResolvedValue({
      data: {
        choices: [{ message: { content: completion } }],
        usage: { total_tokens: 17 },
      },
    } as any)
    const client = createOpenAIClient()
    client.config({ baseURL: 'https://example.test', apiKey: 'sk-private', model: 'safe-model' })

    await client.createChatCompletion({ messages: [{ role: 'user', content: source }] })

    const logs = JSON.stringify([
      ...jest.mocked(logger.info).mock.calls,
      ...jest.mocked(logger.debug).mock.calls,
      ...jest.mocked(logger.error).mock.calls,
    ])
    expect(logs).not.toContain(source)
    expect(logs).not.toContain('PRIVATE_LLM_SEGMENT')
    expect(logs).not.toContain('sk-private')
    expect(logs).toContain('safe-model')
    expect(logs).toContain('promptLength')
    expect(logs).toContain('responseLength')
    expect(logs).toContain('durationMs')
    expect(logs).toContain('tokenCount')
  })
})
