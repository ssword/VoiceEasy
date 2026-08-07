import express, { Application } from 'express'
import { logger } from './utils/logger'
import { createMiddlewareConfig } from './middleware/config'
import { configureStaticFiles } from './middleware/static'
import { setupRoutes } from './routes'
import { registerEngines } from './tts/engines'
import { ttsPluginManager } from './tts/pluginManager'
import { errorHandler } from './middleware/error.middleware'
import { TTSEngine } from './tts/types'

// 应用配置接口
interface AppConfig {
  isDev: boolean
  rateLimit: number
  rateLimitWindow: number
  audioDir: string
  publicDir: string
  engines?: TTSEngine[]
}

// 创建应用工厂函数
export function createApp(config: AppConfig): Application {
  const { isDev, rateLimit, rateLimitWindow, audioDir, publicDir } = config
  logger.debug('Initializing application...')

  const app = express()

  // 配置中间件
  const middleware = createMiddlewareConfig({
    isDev,
    rateLimit,
    rateLimitWindow,
  })

  // 应用中间件
  Object.values(middleware).forEach((mw) => app.use(mw))

  // 配置路由
  setupRoutes(app)

  // 配置静态文件服务
  configureStaticFiles(app, { audioDir, publicDir })

  if (config.engines) ttsPluginManager.replaceEngines(config.engines)
  else registerEngines()
  app.use(errorHandler)
  return app
}
