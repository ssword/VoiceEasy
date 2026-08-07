import winston from 'winston'
import { safeErrorMetadata } from './safeMetadata'

const SENSITIVE_FIELD = /(?:password|passphrase|secret|token|authorization|cookie|api[-_]?key|openai[-_]?key)$/i
const CONTENT_FIELD = /^(?:text|prompt|messages|segments|body|requestBody|responseBody)$/i

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`
  if (value instanceof Date) return value.toISOString()
  if ('pipe' in value && typeof value.pipe === 'function') return '[ReadableStream]'
  if (value instanceof Error) return safeErrorMetadata(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen))

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_FIELD.test(key) || CONTENT_FIELD.test(key)
        ? '[REDACTED]'
        : redactSecrets(entry, seen),
    ])
  )
}

const redactLogMetadata = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'message' || key === 'timestamp') continue
    info[key] =
      SENSITIVE_FIELD.test(key) || CONTENT_FIELD.test(key)
        ? '[REDACTED]'
        : redactSecrets(info[key])
  }
  return info
})

export const logger = winston.createLogger({
  level: process.env.DEBUG ? 'debug' : 'info',
  format: winston.format.combine(redactLogMetadata(), winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
})
