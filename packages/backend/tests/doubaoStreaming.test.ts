import { EventEmitter } from 'events'
import http from 'http'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import { createApp } from '../src/app'
import { DoubaoTtsEngine } from '../src/tts/engines/doubaoTts'

jest.mock('franc', () => ({
  franc: jest.fn(() => 'cmn'),
}))

type SocketOptions = { headers?: Record<string, string> }

const FULL_SERVER_RESPONSE = 0x9
const AUDIO_ONLY_SERVER = 0xb
const WITH_EVENT = 0x4

const EVENTS = {
  startConnection: 1,
  finishConnection: 2,
  connectionStarted: 50,
  connectionFailed: 51,
  connectionFinished: 52,
  startSession: 100,
  cancelSession: 101,
  finishSession: 102,
  sessionStarted: 150,
  sessionFinished: 152,
  sessionFailed: 153,
  taskRequest: 200,
  sentenceEnd: 351,
  audio: 352,
} as const

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
    const frame = decodeClientFrame(Buffer.from(data))
    queueMicrotask(() => {
      if (frame.event === EVENTS.startConnection) {
        this.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionStarted))
      } else if (frame.event === EVENTS.startSession) {
        this.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionStarted))
      } else if (frame.event === EVENTS.taskRequest) {
        this.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('ID3-api-stream')))
      } else if (frame.event === EVENTS.finishSession) {
        this.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFinished))
      } else if (frame.event === EVENTS.finishConnection) {
        this.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionFinished))
      }
    })
  }
}

type DecodedClientFrame = {
  event: number
  sessionId?: string
  payload: unknown
}

function decodeClientFrame(frame: Buffer): DecodedClientFrame {
  expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x14, 0x10, 0x00])
  let offset = 4
  const event = frame.readInt32BE(offset)
  offset += 4
  let sessionId: string | undefined
  if (event !== EVENTS.startConnection && event !== EVENTS.finishConnection) {
    const sessionIdLength = frame.readUInt32BE(offset)
    offset += 4
    sessionId = frame.subarray(offset, offset + sessionIdLength).toString('utf8')
    offset += sessionIdLength
  }
  const payloadLength = frame.readUInt32BE(offset)
  offset += 4
  return {
    event,
    sessionId,
    payload: JSON.parse(frame.subarray(offset, offset + payloadLength).toString('utf8')),
  }
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

describe('Doubao TTS Engine Streaming', () => {
  const config = {
    apiKey: 'private-doubao-key',
    resourceId: 'seed-tts-2.0',
    model: 'seed-tts-2.0-standard',
    voice: 'deployment-default-voice',
  }

  it('streams a Segment through the documented WebSocket lifecycle', async () => {
    let socket: FixtureSocket | undefined
    const engine = new DoubaoTtsEngine(config, {
      createWebSocket: (url: string, options: SocketOptions) => {
        socket = new FixtureSocket(url, options)
        return socket
      },
    })

    const audio = (await engine.synthesize('Progressive Doubao fixture', {
      stream: true,
      voice: 'requested-voice',
      rate: '+250%',
      volume: '-200%',
      pitch: '+99Hz',
    })) as Readable
    expect(socket).toBeDefined()
    socket!.open()

    expect(socket!.url).toBe(
      'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream'
    )
    expect(socket!.options.headers).toEqual({
      'X-Api-Key': 'private-doubao-key',
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(decodeClientFrame(socket!.sent[0])).toEqual({
      event: EVENTS.startConnection,
      payload: {},
    })

    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionStarted))
    const startSession = decodeClientFrame(socket!.sent[1])
    expect(startSession).toEqual({
      event: EVENTS.startSession,
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      payload: {
        req_params: {
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
      },
    })

    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionStarted))
    expect(decodeClientFrame(socket!.sent[2])).toEqual({
      event: EVENTS.taskRequest,
      sessionId: startSession.sessionId,
      payload: { text: 'Progressive Doubao fixture' },
    })
    expect(decodeClientFrame(socket!.sent[3])).toEqual({
      event: EVENTS.finishSession,
      sessionId: startSession.sessionId,
      payload: {},
    })

    const firstChunk = new Promise<Buffer>((resolve) => audio.once('data', resolve))
    socket!.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('ID3-first')))
    await expect(firstChunk).resolves.toEqual(Buffer.from('ID3-first'))

    let ended = false
    audio.once('end', () => {
      ended = true
    })
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sentenceEnd))
    await new Promise((resolve) => setImmediate(resolve))
    expect(ended).toBe(false)

    const complete = readAll(audio)
    socket!.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('-second')))
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFinished))
    expect(decodeClientFrame(socket!.sent[4])).toEqual({
      event: EVENTS.finishConnection,
      payload: {},
    })
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionFinished))

    await expect(complete).resolves.toEqual(Buffer.from('-second'))
    expect(socket!.closeCalls).toBe(1)
  })

  it.each([
    ['connection', EVENTS.connectionFailed, { code: 401, message: 'authentication rejected' }],
    ['session', EVENTS.sessionFailed, { code: 550, message: 'synthesis rejected' }],
  ])('propagates a %s failure without exposing credentials', async (_scope, event, payload) => {
    let socket: FixtureSocket | undefined
    const engine = new DoubaoTtsEngine(config, {
      createWebSocket: (url: string, options: SocketOptions) => {
        socket = new FixtureSocket(url, options)
        return socket
      },
    })
    const audio = (await engine.synthesize('failure fixture', { stream: true })) as Readable
    const result = readAll(audio)
    socket!.open()
    if (event === EVENTS.sessionFailed) {
      socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionStarted))
      socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionStarted))
    }

    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, event, payload))

    await expect(result).rejects.toThrow(String(payload.code))
    await expect(result).rejects.not.toThrow(config.apiKey)
    expect(socket!.closeCalls).toBe(1)
  })

  it('rejects a mid-stream failure after forwarding earlier audio', async () => {
    let socket: FixtureSocket | undefined
    const engine = new DoubaoTtsEngine(config, {
      createWebSocket: (url: string, options: SocketOptions) => {
        socket = new FixtureSocket(url, options)
        return socket
      },
    })
    const audio = (await engine.synthesize('mid-stream fixture', { stream: true })) as Readable
    socket!.open()
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionStarted))
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionStarted))
    const firstChunk = new Promise<Buffer>((resolve) => audio.once('data', resolve))
    socket!.receive(serverFrame(AUDIO_ONLY_SERVER, EVENTS.audio, Buffer.from('ID3-partial')))
    await expect(firstChunk).resolves.toEqual(Buffer.from('ID3-partial'))
    const result = readAll(audio)

    socket!.receive(
      serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFailed, {
        code: 503,
        message: 'upstream interrupted',
      })
    )

    await expect(result).rejects.toThrow(/503.*upstream interrupted/i)
    expect(socket!.closeCalls).toBe(1)
  })

  it.each([
    ['a malformed binary frame', Buffer.from([0x11, 0x94]), /malformed binary frame/i],
    [
      'a terminal session with zero audio',
      serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionFinished),
      /zero audio bytes/i,
    ],
  ])('rejects %s', async (_name, terminalFrame, expected) => {
    let socket: FixtureSocket | undefined
    const engine = new DoubaoTtsEngine(config, {
      createWebSocket: (url: string, options: SocketOptions) => {
        socket = new FixtureSocket(url, options)
        return socket
      },
    })
    const audio = (await engine.synthesize('invalid fixture', { stream: true })) as Readable
    const result = readAll(audio)
    socket!.open()
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionStarted))
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionStarted))

    socket!.receive(terminalFrame)

    await expect(result).rejects.toThrow(expected)
    expect(socket!.closeCalls).toBe(1)
  })

  it('cancels the session and closes the WebSocket when the client closes the stream', async () => {
    let socket: FixtureSocket | undefined
    const engine = new DoubaoTtsEngine(config, {
      createWebSocket: (url: string, options: SocketOptions) => {
        socket = new FixtureSocket(url, options)
        return socket
      },
    })
    const audio = (await engine.synthesize('client cancellation fixture', {
      stream: true,
    })) as Readable
    socket!.open()
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.connectionStarted))
    socket!.receive(serverFrame(FULL_SERVER_RESPONSE, EVENTS.sessionStarted))
    const closed = new Promise<void>((resolve) => audio.once('close', resolve))

    audio.destroy()
    await closed

    expect(decodeClientFrame(socket!.sent[4])).toEqual({
      event: EVENTS.cancelSession,
      sessionId: decodeClientFrame(socket!.sent[1]).sessionId,
      payload: {},
    })
    expect(socket!.closeCalls).toBe(1)
    expect(audio.readableEnded).toBe(false)
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
