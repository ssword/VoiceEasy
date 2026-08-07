import { AxiosError } from 'axios'
import { MODEL_NAME, OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_TIMEOUT_MS } from '../config'
import { logger } from './logger'
import { fetcher } from './request'

// 配置接口定义
interface OpenAIConfig {
  baseURL?: string
  model?: string
  timeout: number
  apiKey?: string
}

/**
 * 创建 OpenAI 客户端实例
 * @returns OpenAI 工具函数集合
 */
export function createOpenAIClient() {
  // 默认配置
  let currentConfig: OpenAIConfig = {
    baseURL: OPENAI_BASE_URL,
    model: MODEL_NAME,
    timeout: OPENAI_TIMEOUT_MS,
    apiKey: OPENAI_API_KEY,
  }
  logger.debug(`init openai with: `, {
    ...currentConfig,
    apiKey: currentConfig?.apiKey ? '[REDACTED]' : undefined,
  })
  // 设置 headers
  const getHeaders = () => ({
    Authorization: `Bearer ${currentConfig.apiKey}`,
    'Content-Type': 'application/json',
  })

  /**
   * 创建 Chat Completion
   * @param request 请求参数
   * @param customConfig 自定义配置，可覆盖默认配置
   */
  async function createChatCompletion(
    request: ChatCompletionRequest,
    customConfig?: Partial<OpenAIConfig>
  ): Promise<ChatCompletionResponse> {
    try {
      const mergedConfig = {
        ...currentConfig,
        ...customConfig,
      }

      const response = await fetcher.post<ChatCompletionResponse>(
        `${mergedConfig.baseURL}${mergedConfig.baseURL?.endsWith('/') ? '' : '/'}chat/completions`,
        {
          model: request.model || mergedConfig.model,
          temperature: request.temperature ?? 1.0,
          max_tokens: request.max_tokens,
          top_p: request.top_p ?? 1.0,
          stream: request.stream ?? false,
          ...request,
        },
        {
          headers: getHeaders(),
          timeout: mergedConfig.timeout,
        }
      )

      // Log LLM request/response summary
      const requestModel = request.model || mergedConfig.model
      const lastMsg = request.messages?.[request.messages.length - 1]
      const promptPreview = typeof lastMsg?.content === 'string' ? lastMsg.content.slice(0, 150) : ''
      logger.info(`LLM → ${requestModel} | ${promptPreview}...`)
      const responseContent = response.data?.choices?.[0]?.message?.content
      const resStr = typeof responseContent === 'string' ? responseContent : JSON.stringify(responseContent)
      logger.info(`LLM ← ${requestModel} | tokens:${response.data?.usage?.total_tokens ?? '?'} | ${resStr.slice(0, 500)}`)
      logger.debug(`LLM ← full content:\n${resStr}`)

      return response.data
    } catch (error) {
      if (error instanceof AxiosError) {
        logger.error(`LLM error: ${error.response?.status} ${JSON.stringify(error.response?.data?.error || error.message).slice(0, 300)}`)
      }
      throw new Error(
        `Chat completion request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * 获取可用模型列表
   */
  async function getModels(): Promise<{ data: { id: string }[] }> {
    try {
      const response = await fetcher.get<{ data: { id: string }[] }>(
        `${currentConfig.baseURL}/models`,
        {},
        {
          headers: getHeaders(),
          timeout: currentConfig.timeout,
        }
      )
      return response.data
    } catch (error) {
      throw new Error(
        `Get models failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * 动态更新配置
   * @param newConfig 新的配置参数
   */
  function config(newConfig: Partial<OpenAIConfig>) {
    currentConfig = {
      ...currentConfig,
      ...newConfig,
    }
    logger.debug(`openai currentConfig:`, {
      ...currentConfig,
      apiKey: currentConfig.apiKey ? '[REDACTED]' : undefined,
    })
  }

  return {
    createChatCompletion,
    getModels,
    config,
  }
}

export const openai = createOpenAIClient()
