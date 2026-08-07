import { Request, Response, NextFunction } from 'express'
import { logger, redactSecrets } from '../utils/logger'
import { ErrorMessages } from '../services/tts.service'

type HttpError = Error & { statusCode?: number; errorCode?: string }

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  const errorDetails = {
    name: err.name,
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
    request: {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      query: req.query,
      params: req.params,
      ip: req.ip,
    },
  }

  logger.error('Error occurred:', redactSecrets(errorDetails))
  const httpError = err as HttpError
  const status = httpError.statusCode ?? getStatus(err.message)
  res.status(status).json({
    success: false,
    message: err.message,
    ...(httpError.errorCode ? { code: httpError.errorCode } : {}),
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  })
}
function getStatus(message: string): number {
  if (message.includes(ErrorMessages.ENG_MODEL_INVALID_TEXT)) return 400
  return 500
}
