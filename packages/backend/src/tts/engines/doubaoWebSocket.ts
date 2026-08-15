import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { WebSocket } from 'ws'

const ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream'
const FULL_CLIENT_REQUEST = 0x1
const FULL_SERVER_RESPONSE = 0x9
const AUDIO_ONLY_SERVER = 0xb
const ERROR_RESPONSE = 0xf
const WITH_EVENT = 0x4

const EVENTS = {
  finishConnection: 2,
  connectionStarted: 50,
  connectionFailed: 51,
  connectionFinished: 52,
  sessionCanceled: 151,
  sessionFinished: 152,
  sessionFailed: 153,
  usageResponse: 154,
  sentenceStart: 350,
  sentenceEnd: 351,
  audio: 352,
  subtitle: 364,
} as const

type WebSocketOptions = { headers: Record<string, string> }

export interface DoubaoWebSocketLike {
  readonly readyState: number
  on(event: 'open', listener: () => void): this
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this
  send(data: Buffer): void
  close(): void
}

export type DoubaoWebSocketFactory = (
  url: string,
  options: WebSocketOptions
) => DoubaoWebSocketLike

export interface DoubaoStreamingRequest {
  apiKey: string
  resourceId: string
  speaker: string
  model: string
  payload: Record<string, unknown>
  onDiagnostic?: (diagnostic: DoubaoStreamingDiagnostic) => void
}

export interface DoubaoStreamingDiagnostic {
  status: 'completed' | 'failed'
  audioBytes: number
  error?: string
}

type ServerFrame = {
  type: number
  event?: number
  errorCode?: number
  payload: Buffer
}

export const defaultDoubaoWebSocketFactory: DoubaoWebSocketFactory = (url, options) =>
  new WebSocket(url, options) as DoubaoWebSocketLike

export function createDoubaoAudioStream(
  request: DoubaoStreamingRequest,
  createWebSocket: DoubaoWebSocketFactory
): Readable {
  let sessionFinished = false
  let connectionFinished = false
  let audioBytes = 0
  let failure: Error | undefined
  let timeout: NodeJS.Timeout | undefined
  let socket: DoubaoWebSocketLike
  let diagnosticReported = false

  const reportDiagnostic = (
    status: DoubaoStreamingDiagnostic['status'],
    error?: Error
  ) => {
    if (diagnosticReported) return
    diagnosticReported = true
    request.onDiagnostic?.({ status, audioBytes, error: error?.message })
  }

  const stream = new Readable({
    read() {},
    destroy(error, callback) {
      clearTimeout(timeout)
      if (!connectionFinished && socket && socket.readyState <= 1) socket.close()
      callback(error)
    },
  })

  const resetTimeout = () => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      fail(new Error('Doubao Streaming timed out waiting for an upstream event.'))
    }, 120_000)
    timeout.unref()
  }

  const fail = (error: Error) => {
    if (failure || sessionFinished) return
    failure = redactError(error, request.apiKey)
    reportDiagnostic('failed', failure)
    stream.destroy(failure)
  }

  try {
    socket = createWebSocket(ENDPOINT, {
      headers: {
        'X-Api-Key': request.apiKey,
        'X-Api-Resource-Id': request.resourceId,
        'X-Api-Request-Id': randomUUID(),
      },
    })
  } catch {
    queueMicrotask(() => fail(new Error('Doubao Streaming WebSocket connection failed.')))
    return stream
  }

  socket.on('open', () => {
    resetTimeout()
    try {
      sendFullRequest(socket, request.payload)
    } catch {
      fail(new Error('Doubao Streaming failed to submit the synthesis request.'))
    }
  })

  socket.on('message', (data, isBinary) => {
    resetTimeout()
    if (!isBinary) {
      fail(new Error('Doubao Streaming returned a malformed text frame.'))
      return
    }

    let frame: ServerFrame
    try {
      frame = decodeServerFrame(toBuffer(data))
    } catch {
      fail(new Error('Doubao Streaming returned a malformed binary frame.'))
      return
    }

    if (frame.type === ERROR_RESPONSE) {
      fail(upstreamError('protocol', frame.payload, frame.errorCode))
      return
    }

    switch (frame.event) {
      case EVENTS.connectionFailed:
        fail(upstreamError('connection', frame.payload))
        return
      case EVENTS.sessionCanceled:
        fail(new Error('Doubao Streaming synthesis was canceled upstream.'))
        return
      case EVENTS.sessionFailed:
        fail(upstreamError('session', frame.payload))
        return
      case EVENTS.audio:
        if (frame.type !== AUDIO_ONLY_SERVER || !frame.payload.length) {
          fail(new Error('Doubao Streaming returned a malformed audio frame.'))
          return
        }
        audioBytes += frame.payload.length
        stream.push(frame.payload)
        return
      case EVENTS.sessionFinished:
        if (audioBytes === 0) {
          fail(new Error('Doubao Streaming completed with zero audio bytes.'))
          return
        }
        sessionFinished = true
        reportDiagnostic('completed')
        clearTimeout(timeout)
        stream.push(null)
        try {
          sendEventFrame(socket, EVENTS.finishConnection, {})
          resetTimeout()
        } catch {
          if (socket.readyState <= 1) socket.close()
        }
        return
      case EVENTS.connectionFinished:
        if (!sessionFinished) {
          fail(new Error('Doubao Streaming connection ended before the terminal session event.'))
          return
        }
        connectionFinished = true
        clearTimeout(timeout)
        if (socket.readyState <= 1) socket.close()
        return
      case EVENTS.sentenceStart:
      case EVENTS.sentenceEnd:
      case EVENTS.subtitle:
      case EVENTS.usageResponse:
        return
      default:
        fail(new Error(`Doubao Streaming returned unexpected event ${frame.event ?? 'unknown'}.`))
    }
  })

  socket.on('error', () => {
    fail(new Error('Doubao Streaming WebSocket failed.'))
  })

  socket.on('close', (code, reason) => {
    clearTimeout(timeout)
    if (failure || connectionFinished) return
    if (sessionFinished) {
      connectionFinished = true
      return
    }
    const detail = reason?.toString('utf8').trim()
    fail(
      new Error(
        `Doubao Streaming WebSocket closed before completion (code ${code}${
          detail ? `: ${detail}` : ''
        }).`
      )
    )
  })

  return stream
}

function sendFullRequest(socket: DoubaoWebSocketLike, payload: Record<string, unknown>) {
  const payloadBytes = Buffer.from(JSON.stringify(payload))
  const frame = Buffer.alloc(4 + 4 + payloadBytes.length)
  frame.set([0x11, FULL_CLIENT_REQUEST << 4, 0x10, 0x00], 0)
  frame.writeUInt32BE(payloadBytes.length, 4)
  payloadBytes.copy(frame, 8)
  socket.send(frame)
}

function sendEventFrame(
  socket: DoubaoWebSocketLike,
  event: number,
  payload: Record<string, unknown>
) {
  const payloadBytes = Buffer.from(JSON.stringify(payload))
  const frame = Buffer.alloc(4 + 4 + 4 + payloadBytes.length)
  frame.set([0x11, (FULL_CLIENT_REQUEST << 4) | WITH_EVENT, 0x10, 0x00], 0)
  let offset = 4
  frame.writeInt32BE(event, offset)
  offset += 4
  frame.writeUInt32BE(payloadBytes.length, offset)
  offset += 4
  payloadBytes.copy(frame, offset)
  socket.send(frame)
}

function decodeServerFrame(frame: Buffer): ServerFrame {
  if (frame.length < 8) throw new Error('short frame')
  const version = frame[0] >> 4
  const headerSize = (frame[0] & 0x0f) * 4
  const type = frame[1] >> 4
  const flag = frame[1] & 0x0f
  const compression = frame[2] & 0x0f
  if (version !== 1 || headerSize < 4 || frame.length < headerSize + 4 || compression !== 0) {
    throw new Error('invalid header')
  }
  if (![FULL_SERVER_RESPONSE, AUDIO_ONLY_SERVER, ERROR_RESPONSE].includes(type)) {
    throw new Error('invalid message type')
  }

  let offset = headerSize
  let errorCode: number | undefined
  if (type === ERROR_RESPONSE) {
    errorCode = readUInt32(frame, offset)
    offset += 4
  }

  let event: number | undefined
  if (flag === WITH_EVENT) {
    event = readInt32(frame, offset)
    offset += 4
    if (![EVENTS.connectionStarted, EVENTS.connectionFailed, EVENTS.connectionFinished].includes(event as 50)) {
      const sessionLength = readUInt32(frame, offset)
      offset += 4 + sessionLength
      if (offset > frame.length) throw new Error('invalid session id')
    } else {
      const connectLength = readUInt32(frame, offset)
      offset += 4 + connectLength
      if (offset > frame.length) throw new Error('invalid connection id')
    }
  } else if (flag !== 0) {
    throw new Error('unsupported flags')
  }

  const payloadLength = readUInt32(frame, offset)
  offset += 4
  if (payloadLength !== frame.length - offset) throw new Error('invalid payload size')
  return { type, event, errorCode, payload: frame.subarray(offset) }
}

function readUInt32(frame: Buffer, offset: number) {
  if (offset + 4 > frame.length) throw new Error('short integer')
  return frame.readUInt32BE(offset)
}

function readInt32(frame: Buffer, offset: number) {
  if (offset + 4 > frame.length) throw new Error('short integer')
  return frame.readInt32BE(offset)
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) return Buffer.concat(data)
  throw new Error('unsupported WebSocket frame')
}

function upstreamError(scope: string, payload: Buffer, errorCode?: number): Error {
  let code = errorCode == null ? '' : ` ${errorCode}`
  let message = ''
  try {
    const parsed = JSON.parse(payload.toString('utf8')) as { code?: unknown; message?: unknown }
    if (parsed.code != null) code = ` ${String(parsed.code)}`
    if (typeof parsed.message === 'string') message = `: ${parsed.message}`
  } catch {
    // Binary protocol errors are still reported without reflecting arbitrary upstream bytes.
  }
  return new Error(`Doubao Streaming ${scope} failed${code}${message}.`)
}

function redactError(error: Error, secret: string): Error {
  return new Error(secret ? error.message.split(secret).join('[redacted]') : error.message)
}
