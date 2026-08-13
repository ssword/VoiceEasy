import { EventEmitter } from 'events'
import http from 'http'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import { createApp } from '../src/app'
import { DoubaoTtsEngine } from '../src/tts/engines/doubaoTts'
import { TtsOptions } from '../src/tts/types'
import { logger } from '../src/utils/logger'

jest.mock('franc', () => ({
  franc: jest.fn(() => 'cmn'),
}))

jest.mock('../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

type SocketOptions = { headers?: Record<string, string> }

const FULL_SERVER_RESPONSE = 0x9
const AUDIO_ONLY_SERVER = 0xb
const WITH_EVENT = 0x4

const EVENTS = {
  finishConnection: 2,
  connectionFailed: 51,
  connectionFinished: 52,
  sessionCanceled: 151,
  sessionFinished: 152,
  sessionFailed: 153,
  sentenceEnd: 351,
  audio: 352,
} as const

const config = {
  apiKey: 'private-doubao-key',
  resourceId: 'seed-tts-2.0',
  model: 'seed-tts-2.0-standard',
  voice: 'deployment-default-voice',
}

class FixtureSocket extends EventEmitter {
  readonly sent: Buffer[] = []
  readonly url: string
  readonly options: SocketOptions
  readyState = 0
  closeCalls = 0

  constructor(url: string, options: SocketOptions) {
    super()
    this.url = url
    this.options = options
  }

  open() {
    this.readyState = 1
    this.emit('open')
  }

  send(data: Buffer) {
    this.sent.push(Buffer.from(data))
  }

  close() {
    this.closeCalls++
    this.readyState = 3
    this.emit('close', 1000, Buffer.alloc(0))
  }

  receive(frame: Buffer) {
    this.emit('message', frame, true)
  }
}

class SuccessfulFixtureSocket extends FixtureSocket {
  send(data: Buffer) {
    super.send(data)
    const isEventFrame = (data[1] & 0x0f) === WITH_EVENT
    queueMicrotask(() => {
      if (!isEventFrame) {
        decodeFullRequest(Buffer.from(data))
        this.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('ID3-api-stream')))
        this.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFinished))
      } else if (decodeEventFrame(Buffer.from(data)).event === EVENTS.finishConnection) {
        this.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionFinished))
      }
    })
  }
}

function decodeEventFrame(frame: Buffer) {
  expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x14, 0x10, 0x00])
  let offset = 4
  const event = frame.readInt32BE(offset)
  offset += 4
  const payloadLength = frame.readUInt32BE(offset)
  offset += 4
  return {
    event,
    payload: JSON.parse(frame.subarray(offset, offset + payloadLength).toString('utf8')),
  }
}

function decodeFullRequest(frame: Buffer) {
  expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x10, 0x10, 0x00])
  const payloadLength = frame.readUInt32BE(4)
  expect(frame.length).toBe(8 + payloadLength)
  return JSON.parse(frame.subarray(8).toString('utf8'))
}

function serverFrame(type: number, event: number, payload: Buffer | object = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))
  const sessionId = event >= 100 ? Buffer.from('server-session') : Buffer.alloc(0)
  const connectId = event >= 50 && event <= 52 ? Buffer.from('server-connection') : Buffer.alloc(0)
  const frame = Buffer.alloc(4 + 4 + (sessionId.length ? 4 + sessionId.length : 0) +
    (connectId.length ? 4 + connectId.length : 0) + 4 + body.length)
  frame.set([0x11, (type << 4) | WITH_EVENT, type === AUDIO_ONLY_SERVER ? 0 : 0x10, 0], 0)
  let offset = 4
  frame.writeInt32BE(event, offset)
  offset += 4
  if (sessionId.length) {
    frame.writeUInt32BE(sessionId.length, offset)
    offset += 4
    sessionId.copy(frame, offset)
    offset += sessionId.length
  }
  if (connectId.length) {
    frame.writeUInt32BE(connectId.length, offset)
    offset += 4
    connectId.copy(frame, offset)
    offset += connectId.length
  }
  frame.writeUInt32BE(body.length, offset)
  offset += 4
  body.copy(frame, offset)
  return frame
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function openFixtureStream(text: string, options: TtsOptions = {}) {
  let socket: FixtureSocket | undefined
  const engine = new DoubaoTtsEngine(config, {
    createWebSocket: (url, socketOptions) => {
      socket = new FixtureSocket(url, socketOptions)
      return socket
    },
  })
  const audio = (await engine.synthesize(text, { ...options, stream: true })) as Readable
  if (!socket) throw new Error('Expected the Doubao Engine to create a WebSocket')
  socket.open()
  return { audio, socket }
}

describe('Doubao TTS Engine Streaming', () => {
  beforeEach(() => jest.clearAllMocks())

  it('streams a Segment through the documented unidirectional request lifecycle', async () => {
    const { audio, socket } = await openFixtureStream('Progressive Doubao fixture', {
      voice: 'requested-voice',
      rate: '+250%',
      volume: '-200%',
      pitch: '+99Hz',
    })

    expect(socket.url).toBe(
      'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream'
    )
    expect(socket.options.headers).toEqual({
      'X-Api-Key': 'private-doubao-key',
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(decodeFullRequest(socket.sent[0])).toEqual({
      req_params: {
        text: 'Progressive Doubao fixture',
        model: 'seed-tts-2.0-standard',
        speaker: 'requested-voice',
        audio_params: {
          format: 'mp3',
          sample_rate: 24000,
          speech_rate: 100,
          loudness_rate: -50,
        },
        additions: JSON.stringify({ post_process: { pitch: 12 } }),
      },
    })

    const firstChunk = new Promise<Buffer>((resolve) => audio.once('data', resolve))
    socket.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('ID3-first')))
    await expect(firstChunk).resolves.toEqual(Buffer.from('ID3-first'))

    let ended = false
    audio.once('end', () => {
      ended = true
    })
    socket.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sentenceEnd))
    await new Promise((resolve) => setImmediate(resolve))
    expect(ended).toBe(false)

    const complete = readAll(audio)
    socket.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('-second')))
    socket.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFinished))
    expect(decodeEventFrame(socket.sent[1])).toEqual({
      event: EVENTS.finishConnection,
      payload: {},
    })
    socket.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionFinished))

    await expect(complete).resolves.toEqual(Buffer.from('-second'))
    expect(socket.closeCalls).toBe(1)
  })

  it('records safe Streaming completion diagnostics', async () => {
    const { audio, socket } = await openFixtureStream('PRIVATE_STREAMING_SOURCE')
    const complete = readAll(audio)

    socket.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('ID3-stream')))
    socket.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFinished))
    await complete

    expect(logger.info).toHaveBeenCalledWith('Doubao Streaming completed', {
      engine: 'doubao-tts',
      resourceId: 'seed-tts-2.0',
      status: 'completed',
      audioBytes: Buffer.byteLength('ID3-stream'),
    })
    const logs = JSON.stringify(jest.mocked(logger.info).mock.calls)
    expect(logs).not.toContain('PRIVATE_STREAMING_SOURCE')
    expect(logs).not.toContain(config.apiKey)
  })

  it.each([
    ['connection', EVENTS.connectionFailed, { code: 401, message: 'authentication rejected' }],
    ['session', EVENTS.sessionFailed, { code: 550, message: 'synthesis rejected' }],
  ])('propagates a %s failure without exposing credentials', async (_scope, event, payload) => {
    const { audio, socket } = await openFixtureStream('failure fixture')
    const result = readAll(audio)

    socket.receive(serverFrame(FULL_SERVER_RESPONSE, event, payload))

    await expect(result).rejects.toThrow(String(payload.code))
    await expect(result).rejects.not.toThrow(config.apiKey)
    expect(socket.closeCalls).toBe(1)
  })

  it('rejects a mid-stream failure after forwarding earlier audio', async () => {
    const { audio, socket } = await openFixtureStream('mid-stream fixture')
    const firstChunk = new Promise<Buffer>((resolve) => audio.once('data', resolve))
    socket.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('ID3-partial')))
    await expect(firstChunk).resolves.toEqual(Buffer.from('ID3-partial'))
    const result = readAll(audio)

    socket.receive(
      serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFailed, {
        code: 503,
        message: 'upstream interrupted',
      })
    )

    await expect(result).rejects.toThrow(/503.*upstream interrupted/i)
    expect(socket.closeCalls).toBe(1)
  })

  it.each([
    ['a malformed binary frame', Buffer.from([0x11, 0x94]), /malformed binary frame/i],
    [
      'a terminal session with zero audio',
      serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFinished),
      /zero audio bytes/i,
    ],
  ])('rejects %s', async (_name, terminalFrame, expected) => {
    const { audio, socket } = await openFixtureStream('invalid fixture')
    const result = readAll(audio)

    socket.receive(terminalFrame)

    await expect(result).rejects.toThrow(expected)
    expect(socket.closeCalls).toBe(1)
  })

  it('closes the WebSocket without reporting success when the client closes the stream', async () => {
    const { audio, socket } = await openFixtureStream('client cancellation fixture')
    const closed = new Promise<void>((resolve) => audio.once('close', resolve))

    audio.destroy()
    await closed

    expect(socket.sent).toHaveLength(1)
    expect(socket.closeCalls).toBe(1)
    expect(audio.readableEnded).toBe(false)
  })

  it('rejects an upstream cancellation event', async () => {
    const { audio, socket } = await openFixtureStream('upstream cancellation fixture')
    const result = readAll(audio)

    socket.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionCanceled))

    await expect(result).rejects.toThrow(/canceled upstream/i)
    expect(socket.closeCalls).toBe(1)
  })
})

describe('Doubao Streaming API integration', () => {
  let server: http.Server

  beforeAll((done) => {
    const engine = new DoubaoTtsEngine(
      {
        apiKey: 'private-doubao-key',
        resourceId: 'seed-tts-2.0',
        model: 'seed-tts-2.0-standard',
      },
      {
        createWebSocket: (url, options) => {
          const socket = new SuccessfulFixtureSocket(url, options)
          queueMicrotask(() => socket.open())
          return socket
        },
      }
    )
    const app = createApp({
      isDev: true,
      rateLimit: 1e6,
      rateLimitWindow: 10,
      audioDir: '/tmp/easyvoice-doubao-stream-test-audio',
      publicDir: '/tmp/easyvoice-doubao-stream-test-public',
      engines: [engine],
    })
    server = http.createServer(app)
    server.listen(0, '127.0.0.1', done)
  })

  afterAll((done) => {
    server.close(() => done())
  })

  it('serves progressive Doubao audio through the existing createStream route', async () => {
    const address = server.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/tts/createStream`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: '这是豆包流式接口测试。',
          voice: 'zh_female_tianmeitaozi_mars_bigtts',
          engine: 'doubao-tts',
        }),
      }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/octet-stream')
    expect(response.headers.get('x-generate-tts-type')).toBe('stream')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('ID3-api-stream'))
  })
})
