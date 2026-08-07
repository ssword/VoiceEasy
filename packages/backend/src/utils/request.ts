import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { logger } from './logger'
import { safeErrorMetadata } from './diagnostics'

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
    logger.info('Upstream request started', {
      method: config.method?.toUpperCase(),
      path: config.url?.split('?')[0],
    })
    return config
  },
  (error) => {
    logger.error('Request interceptor failed', { error: safeErrorMetadata(error) })
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
    logger.info('Upstream request succeeded', {
      method: response.config.method?.toUpperCase(),
      path: response.config.url?.split('?')[0],
      status: response.status,
    })
    return response
  },
  (error) => {
    const config = error.config as CustomConfig
    const url = config.url || 'unknown URL'

    if (error.response) {
      const { status } = error.response
      logger.error('Upstream HTTP request failed', {
        status,
        method: config.method?.toUpperCase(),
        path: url.split('?')[0],
        error: safeErrorMetadata(error),
      })
    } else if (error.code === 'ECONNABORTED') {
      logger.error('Upstream request timed out', {
        method: config.method?.toUpperCase(),
        path: url.split('?')[0],
        error: safeErrorMetadata(error),
      })
    } else {
      logger.error('Upstream network request failed', {
        method: config.method?.toUpperCase(),
        path: url.split('?')[0],
        error: safeErrorMetadata(error),
      })
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
      logger.error('Upstream request failed', {
        method: config.method?.toUpperCase(),
        path: config.url?.split('?')[0] || 'unknown URL',
        status: error?.response?.status,
        error: safeErrorMetadata(error),
      })
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
