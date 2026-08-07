import { EventEmitter } from 'events'
import { PassThrough, Readable } from 'stream'
import { spawn } from 'child_process'
import { CosyVoiceTtsEngine } from '../src/tts/engines/cosyVoiceTts'
import { QwenAudioTtsEngine } from '../src/tts/engines/qwenAudioTts'
import { fetcher } from '../src/utils/request'

jest.mock('../src/utils/request', () => ({
  fetcher: {
    get: jest.fn(),
    post: jest.fn(),
  },
}))

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

jest.mock('../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}))

const qwen = (model = 'qwen-audio-3.0-tts-plus') =>
  new QwenAudioTtsEngine({
    apiKey: 'test-key',
    workspaceId: 'test-workspace',
    model,
  })

const cosyVoice = () =>
  new CosyVoiceTtsEngine({
    apiKey: 'test-key',
    workspaceId: 'test-workspace',
    model: 'cosyvoice-v3-flash',
  })

const sse = (...payloads: string[]) =>
  Readable.from(payloads.map((payload) => Buffer.from(`data:${payload}\n\n`)))

const readAll = async (readable: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

describe('Qwen-Audio-TTS Engine Plugin protocol', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('puts Qwen synthesis options inside input as required by its HTTP API', async () => {
    jest.mocked(fetcher.post).mockResolvedValue({
      data: sse('[DONE]'),
    } as any)

    const stream = await qwen('qwen-audio-3.0-tts-flash').synthesize('您好，请坐。', {
      voice: 'longanfengyue',
      rate: '+20%' as any,
      volume: '-10%' as any,
      instruction: '用温和专业的语气说话',
      stream: true,
    })
    ;(stream as Readable).on('error', () => undefined)

    expect(fetcher.post).toHaveBeenCalledWith(
      expect.any(String),
      {
        model: 'qwen-audio-3.0-tts-flash',
        input: {
          text: '您好，请坐。',
          voice: 'longanfengyue',
          format: 'mp3',
          sample_rate: 24000,
          rate: 1.2,
          volume: 40,
          instruction: '用温和专业的语气说话',
        },
      },
      expect.objectContaining({ responseType: 'stream' })
    )
  })

  it('only exposes system Voices supported by the configured model', async () => {
    const flashNames = (await qwen('qwen-audio-3.0-tts-flash').getVoiceOptions()).map(
      (voice: any) => voice.Name
    )
    const plusNames = (await qwen().getVoiceOptions()).map((voice: any) => voice.Name)

    expect(flashNames).toContain('longanfengyue')
    expect(flashNames).not.toContain('longanlingxin')
    expect(plusNames).toContain('longanlingxin')
    expect(plusNames).not.toContain('longanfengyue')
    expect(plusNames.every((name) => !name.startsWith('qwen-audio-3.0-tts-'))).toBe(true)
  })

  it('returns decoded MP3 bytes for Streaming and non-streaming synthesis', async () => {
    const mp3 = Buffer.from('ID3-test-audio')
    jest.mocked(fetcher.post).mockImplementation(async () => ({
      data: sse(JSON.stringify({ output: { audio: { data: mp3.toString('base64') } } }), '[DONE]'),
    } as any))

    const streaming = await qwen().synthesize('streaming', { stream: true })
    const buffered = await qwen().synthesize('buffered', { stream: false })

    await expect(readAll(streaming as Readable)).resolves.toEqual(mp3)
    expect(buffered).toEqual(mp3)
  })

  it('decodes a final SSE event even when the transport omits its trailing newline', async () => {
    const mp3 = Buffer.from('ID3-tail')
    jest.mocked(fetcher.post).mockResolvedValue({
      data: Readable.from([
        Buffer.from(`data:${JSON.stringify({ output: { audio: { data: mp3.toString('base64') } } })}`),
      ]),
    } as any)

    const audio = await qwen().synthesize('hello', { stream: true })

    await expect(readAll(audio as Readable)).resolves.toEqual(mp3)
  })

  it.each([
    [
      'business error',
      () => sse(JSON.stringify({ code: 'InvalidParameter', message: 'unsupported voice' })),
      /InvalidParameter.*unsupported voice/,
    ],
    ['malformed event', () => sse('{not-json'), /malformed/i],
    ['zero-byte completion', () => sse('[DONE]'), /zero audio bytes/i],
  ])('rejects a %s SSE response', async (_name, makeStream, expectedError) => {
    jest.mocked(fetcher.post).mockResolvedValue({ data: makeStream() } as any)
    const audio = await qwen().synthesize('hello', { stream: true })

    await expect(readAll(audio as Readable)).rejects.toThrow(expectedError)
  })

  it('propagates a transport error from the DashScope SSE stream', async () => {
    const upstream = new PassThrough()
    jest.mocked(fetcher.post).mockResolvedValue({ data: upstream } as any)
    const audio = await qwen().synthesize('hello', { stream: true })
    const failure = readAll(audio as Readable)

    upstream.destroy(new Error('socket reset'))

    await expect(failure).rejects.toThrow('socket reset')
  })
})

describe('CosyVoice Engine Plugin protocol', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('owns the CosyVoice request shape and downloads a non-streaming audio URL', async () => {
    const mp3 = Buffer.from('ID3-cosyvoice')
    jest.mocked(fetcher.post).mockResolvedValue({
      data: { output: { audio_url: 'https://audio.example.test/result.mp3' } },
    } as any)
    jest.mocked(fetcher.get).mockResolvedValue({ data: mp3 } as any)

    const result = await cosyVoice().synthesize('你好', {
      voice: 'longxiaochun',
      speed: 1.25,
      volume: 0.75,
    })

    expect(fetcher.post).toHaveBeenCalledWith(
      expect.any(String),
      {
        model: 'cosyvoice-v3-flash',
        input: { text: '你好', voice: 'longxiaochun', format: 'mp3' },
        parameters: { sample_rate: 24000, speed: 1.25, volume: 0.75 },
      },
      expect.not.objectContaining({ responseType: 'stream' })
    )
    expect(fetcher.get).toHaveBeenCalledWith(
      'https://audio.example.test/result.mp3',
      undefined,
      { responseType: 'arraybuffer' }
    )
    expect(result).toEqual(mp3)
  })

  it('decodes Streaming PCM and converts it to MP3 inside the Engine Plugin', async () => {
    const pcm = Buffer.from([1, 2, 3, 4])
    jest.mocked(fetcher.post).mockResolvedValue({
      data: sse(JSON.stringify({ payload: { chunk: pcm.toString('base64') } }), '[DONE]'),
    } as any)

    const process = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      killed: boolean
      kill: jest.Mock
    }
    process.stdin = new PassThrough()
    process.stdout = new PassThrough()
    process.stderr = new PassThrough()
    process.killed = false
    process.kill = jest.fn(() => {
      process.killed = true
    })
    process.stdin.once('data', (chunk) => process.stdout.write(Buffer.concat([Buffer.from('ID3'), chunk])))
    process.stdin.once('end', () => {
      process.stdout.end()
      process.emit('close', 0)
    })
    jest.mocked(spawn).mockReturnValue(process as any)

    const result = await cosyVoice().synthesize('你好', { voice: 'longxiaochun', stream: true })
    const mp3 = await readAll(result as Readable)

    expect(spawn).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-f', 's16le', '-ar', '24000', '-f', 'mp3']),
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    expect(mp3).toEqual(Buffer.concat([Buffer.from('ID3'), pcm]))
  })

  it.each([
    ['ffmpeg exits unsuccessfully', 1, Buffer.from('encoder diagnostics'), /ffmpeg exited with code 1/i],
    ['ffmpeg produces no bytes', 0, Buffer.alloc(0), /zero audio bytes/i],
  ])('rejects Streaming synthesis when %s', async (_name, exitCode, encoded, expected) => {
    const pcm = Buffer.from([1, 2, 3, 4])
    jest.mocked(fetcher.post).mockResolvedValue({
      data: sse(JSON.stringify({ payload: { chunk: pcm.toString('base64') } }), '[DONE]'),
    } as any)

    const process = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      killed: boolean
      kill: jest.Mock
    }
    process.stdin = new PassThrough()
    process.stdout = new PassThrough()
    process.stderr = new PassThrough()
    process.killed = false
    process.kill = jest.fn(() => {
      process.killed = true
    })
    process.stdin.on('data', () => undefined)
    process.stdin.once('end', () => {
      if (encoded.length) process.stdout.write(encoded)
      process.stdout.end()
      process.emit('close', exitCode)
    })
    jest.mocked(spawn).mockReturnValue(process as any)

    const result = await cosyVoice().synthesize('你好', { voice: 'longxiaochun', stream: true })

    await expect(readAll(result as Readable)).rejects.toThrow(expected)
  })
})
