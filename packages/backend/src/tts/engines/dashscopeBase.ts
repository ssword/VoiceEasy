import { PassThrough, Readable } from 'stream'
import { fetcher } from '../../utils/request'

export interface DashScopeConfig {
  apiKey: string
  workspaceId: string
  model: string
}

export class DashScopeUpstreamError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(code ? `DashScope ${code}: ${message}` : `DashScope: ${message}`)
    this.name = 'DashScopeUpstreamError'
  }
}

/** Shared DashScope authentication and HTTP transport. Engine Plugins own payloads and decoding. */
export class DashScopeTransport {
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(config: DashScopeConfig, engineName: string) {
    if (!config.apiKey) {
      throw new Error(`[${engineName}] DASHSCOPE_API_KEY is required.`)
    }
    if (!config.workspaceId) {
      throw new Error(`[${engineName}] DASHSCOPE_WORKSPACE_ID is required.`)
    }

    this.apiKey = config.apiKey
    this.model = config.model
    this.baseUrl = `https://${config.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
  }

  post<T>(body: Record<string, unknown>) {
    return fetcher.post<T>(this.baseUrl, body, {
      headers: this.headers(),
    })
  }

  async stream(body: Record<string, unknown>): Promise<Readable> {
    const response = await fetcher.post(this.baseUrl, body, {
      headers: {
        ...this.headers(),
        'X-DashScope-SSE': 'enable',
      },
      responseType: 'stream',
      timeout: 120_000,
    })
    return response.data as Readable
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
  }
}

interface DecodeSseOptions {
  engineName: string
  decodeAudio(event: unknown): Buffer | undefined
  allowRawBase64?: boolean
}

/** Generic SSE framing and lifecycle checks; audio event shapes remain Engine-specific. */
export function decodeDashScopeSse(source: Readable, options: DecodeSseOptions): Readable {
  const output = new PassThrough()
  let pending = ''
  let audioBytes = 0
  let failed = false

  const fail = (error: Error) => {
    if (failed) return
    failed = true
    output.destroy(error)
  }

  const decodePayload = (payload: string) => {
    if (failed || payload === '[DONE]') return

    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      if (options.allowRawBase64 && isBase64(payload)) {
        const chunk = Buffer.from(payload, 'base64')
        audioBytes += chunk.length
        output.write(chunk)
        return
      }
      fail(new DashScopeUpstreamError(`${options.engineName} returned a malformed SSE event`))
      return
    }

    const upstreamError = getUpstreamError(event)
    if (upstreamError) {
      fail(new DashScopeUpstreamError(upstreamError.message, upstreamError.code))
      return
    }

    try {
      const chunk = options.decodeAudio(event)
      if (chunk?.length) {
        audioBytes += chunk.length
        output.write(chunk)
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  const consume = (complete: boolean) => {
    const lines = pending.split(/\r?\n/)
    const trailing = lines.pop() || ''
    pending = complete ? '' : trailing
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) continue
      decodePayload(trimmed.slice(5).trim())
    }
    if (complete && trailing.trim()) {
      const trimmed = trailing.trim()
      if (trimmed.startsWith('data:')) decodePayload(trimmed.slice(5).trim())
    }
  }

  source.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString()
    consume(false)
  })
  source.once('error', (error) => fail(error))
  source.once('end', () => {
    consume(true)
    if (failed) return
    if (audioBytes === 0) {
      fail(new DashScopeUpstreamError(`${options.engineName} completed with zero audio bytes`))
      return
    }
    output.end()
  })

  return output
}

export async function collectAudio(stream: Readable, engineName: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const audio = Buffer.concat(chunks)
  if (audio.length === 0) {
    throw new DashScopeUpstreamError(`${engineName} completed with zero audio bytes`)
  }
  return audio
}

export function decodeBase64(value: unknown, field: string): Buffer | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !isBase64(value)) {
    throw new DashScopeUpstreamError(`invalid base64 audio in ${field}`)
  }
  return Buffer.from(value, 'base64')
}

function isBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

function getUpstreamError(event: unknown): { code?: string; message: string } | undefined {
  if (!event || typeof event !== 'object') return undefined
  const root = event as Record<string, unknown>
  const header =
    root.header && typeof root.header === 'object'
      ? (root.header as Record<string, unknown>)
      : undefined
  const code = stringValue(root.code) || stringValue(header?.error_code)
  const statusCode = numberValue(root.status_code) ?? numberValue(header?.status_code)
  const message =
    stringValue(root.message) || stringValue(header?.error_message) || stringValue(header?.message)

  if (code || (statusCode !== undefined && statusCode >= 400)) {
    return {
      code: code || String(statusCode),
      message: message || 'upstream synthesis failed',
    }
  }
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
