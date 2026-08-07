import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { logger } from './logger'

// 定义响应数据的通用接口
export interface ResponseData<T> extends AxiosResponse {
  code: number
  data: T
  message: string
  success: boolean
}

// 自定义配置接口，扩展AxiosRequestConfig
interface CustomConfig extends AxiosRequestConfig {
  logError?: boolean
}

const instance: AxiosInstance = axios.create({
  baseURL: process.env.API_URL || 'http://localhost:3000/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
})

instance.interceptors.request.use(
  (config) => {
    // 添加token认证
    const token = process.env.JWT_TOKEN || '' // 假设从环境变量获取token
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    logger.info(`Request started: ${config.method?.toUpperCase()} ${config.url}`)
    return config
  },
  (error) => {
    logger.error('Request interceptor error:', error)
    return Promise.reject(error)
  }
)

instance.interceptors.response.use(
  (response: AxiosResponse<ResponseData<any>>) => {
    const { data } = response
    if (response.status !== 200) {
      if (response.status === 401) {
        logger.warn('Unauthorized request, redirecting to login')
        return Promise.reject(new Error('Unauthorized'))
      }
      return Promise.reject(new Error(data.message || 'Request failed'))
    }
    logger.info(`Request succeeded: ${response.config.url}`)
    return response
  },
  (error) => {
    const config = error.config as CustomConfig
    const url = config.url || 'unknown URL'

    if (error.response) {
      const { status, data } = error.response
      let responseBody: string
      if (typeof data === 'string') {
        // Only show first 300 chars, and only if it looks like text (not binary)
        const preview = data.slice(0, 300)
        responseBody = /^[\x20-\x7e\u4e00-\u9fff\n\r\t{}[\]":,]+/.test(preview)
          ? preview
          : `[Binary/encoded data ${data.length} bytes]`
      } else if (Buffer.isBuffer(data)) {
        responseBody = `[Buffer ${data.length} bytes]`
      } else if (data && typeof data === 'object' && data.pipe) {
        responseBody = `[ReadableStream]`
      } else if (data && typeof data === 'object') {
        try {
          responseBody = JSON.stringify(data).slice(0, 500)
        } catch {
          responseBody = `[Object]`
        }
      } else {
        responseBody = String(data).slice(0, 200)
      }
      logger.error(`HTTP ${status} ${config.method?.toUpperCase()} ${url}: ${responseBody}`)
    } else if (error.code === 'ECONNABORTED') {
      logger.error(`Timeout: ${config.method?.toUpperCase()} ${url}`)
    } else {
      logger.error(`Network error: ${config.method?.toUpperCase()} ${url} — ${error.message}`)
    }
    return Promise.reject(error)
  }
)

const _request = async <T = any>(config: CustomConfig): Promise<ResponseData<T>> => {
  try {
    const response = await instance(config)
    return response as ResponseData<T>
  } catch (error: any) {
    const logError = config.logError ?? true
    if (logError) {
      const msg = error?.response?.status
        ? `Request failed: ${config.url} [${error.response.status}] ${error.message}`
        : `Request failed: ${config.url || 'unknown URL'} — ${error.message}`
      logger.error(msg)
    }
    throw error
  }
}

export const fetcher = {
  get: <T = any>(url: string, params?: object, config?: CustomConfig) =>
    _request<T>({
      url,
      method: 'GET',
      params,
      ...config,
    }),
  post: <T = any>(url: string, data?: object, config?: CustomConfig) =>
    _request<T>({
      url,
      method: 'POST',
      data,
      ...config,
    }),
  put: <T = any>(url: string, data?: object, config?: CustomConfig) =>
    _request<T>({
      url,
      method: 'PUT',
      data,
      ...config,
    }),
  delete: <T = any>(url: string, params?: object, config?: CustomConfig) =>
    _request<T>({
      url,
      method: 'DELETE',
      params,
      ...config,
    }),
}
