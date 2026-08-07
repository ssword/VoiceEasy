import { AxiosError } from 'axios'
import { MODEL_NAME, OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_TIMEOUT_MS } from '../config'
import { logger } from './logger'
import { fetcher } from './request'
import { safeErrorMetadata } from './diagnostics'

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
    model: currentConfig.model,
    timeout: currentConfig.timeout,
    hasBaseUrl: !!currentConfig.baseURL,
    hasApiKey: !!currentConfig.apiKey,
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
    const startedAt = Date.now()
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

      const requestModel = request.model || mergedConfig.model
      const lastMsg = request.messages?.[request.messages.length - 1]
      const responseContent = response.data?.choices?.[0]?.message?.content
      const resStr =
        typeof responseContent === 'string' ? responseContent : JSON.stringify(responseContent) || ''
      logger.info('LLM Recommendation completed', {
        model: requestModel,
        promptLength: typeof lastMsg?.content === 'string' ? lastMsg.content.length : 0,
        responseLength: resStr.length,
        tokenCount: response.data?.usage?.total_tokens,
        durationMs: Date.now() - startedAt,
        retryCount: 0,
      })

      return response.data
    } catch (error) {
      logger.error('LLM Recommendation failed', {
        durationMs: Date.now() - startedAt,
        error: safeErrorMetadata(error),
        ...(error instanceof AxiosError && error.response?.status
          ? { status: error.response.status }
          : {}),
      })
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
      model: currentConfig.model,
      timeout: currentConfig.timeout,
      hasBaseUrl: !!currentConfig.baseURL,
      hasApiKey: !!currentConfig.apiKey,
    })
  }

  return {
    createChatCompletion,
    getModels,
    config,
  }
}

export const openai = createOpenAIClient()
