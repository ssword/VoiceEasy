import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'
import { ErrorMessages } from '../services/tts.service'
import { safeErrorMetadata, safeRequestMetadata } from '../utils/diagnostics'

type HttpError = Error & { statusCode?: number; errorCode?: string }

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  logger.error('HTTP request failed', {
    request: safeRequestMetadata(req),
    error: safeErrorMetadata(err),
  })
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
