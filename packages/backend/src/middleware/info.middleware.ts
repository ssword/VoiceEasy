import expressWinston from 'express-winston'
import { logger } from '../utils/logger'
import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const supplied = req.header('x-request-id')
  const correlationId =
    supplied && /^[A-Za-z0-9._:-]{1,64}$/.test(supplied) ? supplied : crypto.randomUUID()
  res.locals.correlationId = correlationId
  res.setHeader('x-request-id', correlationId)
  next()
}

export const requestLoggerMiddleware = expressWinston.logger({
  winstonInstance: logger,
  meta: false, // 记录请求/响应的详细元数据
  msg: (req, res) => `HTTP ${req.method} [${res.locals.correlationId}]`,
  expressFormat: false,
  colorize: false, // 控制台是否启用颜色（JSON 不需要）
})
