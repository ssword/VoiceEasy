import { PassThrough, Readable } from 'stream'
import { spawn } from 'child_process'
import { TTSEngine, TtsOptions } from '../types'
import { fetcher } from '../../utils/request'
import { logger } from '../../utils/logger'
import {
  DashScopeConfig,
  DashScopeTransport,
  decodeBase64,
  decodeDashScopeSse,
} from './dashscopeBase'

type CosyVoiceResponse = {
  output?: { audio_url?: string }
  code?: string
  message?: string
}

const COSYVOICE_VOICES = [
  { Name: 'longxiaochun', cnName: '龙小春', Gender: 'Female', language: 'zh-CN' },
  { Name: 'longyu', cnName: '龙宇', Gender: 'Male', language: 'zh-CN' },
  { Name: 'longchen', cnName: '龙晨', Gender: 'Male', language: 'zh-CN' },
  { Name: 'longyue', cnName: '龙悦', Gender: 'Female', language: 'zh-CN' },
  { Name: 'longzhe', cnName: '龙哲', Gender: 'Male', language: 'zh-CN' },
  { Name: 'longfei', cnName: '龙飞', Gender: 'Male', language: 'zh-CN' },
  { Name: 'longbai', cnName: '龙白', Gender: 'Male', language: 'zh-CN' },
  { Name: 'longshu', cnName: '龙书', Gender: 'Male', language: 'zh-CN' },
  { Name: 'longjing', cnName: '龙井', Gender: 'Male', language: 'zh-CN' },
  { Name: 'longyi', cnName: '龙一', Gender: 'Male', language: 'zh-CN' },
].map((item) => ({ ...item, ContentCategories: [], VoicePersonalities: [] }))

export class CosyVoiceTtsEngine implements TTSEngine {
  readonly name = 'cosyvoice-tts'
  readonly supportsSubtitles = false
  private readonly transport: DashScopeTransport

  constructor(config: DashScopeConfig) {
    this.transport = new DashScopeTransport(config, this.name)
  }

  async synthesize(text: string, options: TtsOptions): Promise<Buffer | Readable> {
    if (!text) throw new Error('Input text is required.')
    const request = this.buildRequest(text, options)
    return options.stream ? this.synthesizeStream(request) : this.synthesizeBuffer(request)
  }

  async getSupportedLanguages(): Promise<string[]> {
    return ['zh-CN', 'en-US']
  }

  async getVoiceOptions() {
    return COSYVOICE_VOICES
  }

  private buildRequest(text: string, options: TtsOptions): Record<string, unknown> {
    const volume = typeof options.volume === 'number' ? options.volume : 1
    return {
      model: this.transport.model,
      input: {
        text,
        voice: options.voice || 'longxiaochun',
        format: 'mp3',
      },
      parameters: {
        sample_rate: 24000,
        speed: options.speed ?? 1,
        volume: Math.max(0, Math.min(1, volume)),
      },
    }
  }

  private async synthesizeBuffer(request: Record<string, unknown>): Promise<Buffer> {
    const response = await this.transport.post<CosyVoiceResponse>(request)
    if (!response.data || response.data.code) {
      throw new Error(`CosyVoice API error: ${response.data?.message || 'unknown error'}`)
    }
    const audioUrl = response.data.output?.audio_url
    if (!audioUrl) throw new Error('CosyVoice response missing audio_url')

    const audio = await fetcher.get<ArrayBuffer>(audioUrl, undefined, { responseType: 'arraybuffer' })
    const result = Buffer.from(audio.data)
    if (result.length === 0) throw new Error('CosyVoice completed with zero audio bytes')
    return result
  }

  private async synthesizeStream(request: Record<string, unknown>): Promise<Readable> {
    const upstream = await this.transport.stream(request)
    const pcm = decodeDashScopeSse(upstream, {
      engineName: this.name,
      allowRawBase64: true,
      decodeAudio: (event) => decodeBase64((event as any)?.payload?.chunk, 'CosyVoice event'),
    })
    return this.pcmToMp3Stream(pcm)
  }

  private pcmToMp3Stream(pcm: Readable): Readable {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
        '-f', 'mp3', '-b:a', '96k', 'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    pcm.pipe(ffmpeg.stdin!)
    ffmpeg.stderr?.on('data', (data: Buffer) => logger.debug(`[CosyVoice] ffmpeg: ${data.toString().trim()}`))
    const output = new PassThrough()
    let outputBytes = 0
    let settled = false

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      output.destroy(error)
    }
    ffmpeg.stdout!.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      output.write(chunk)
    })
    ffmpeg.stdout!.once('error', fail)
    ffmpeg.once('error', fail)
    pcm.once('error', fail)
    ffmpeg.stdin!.once('error', fail)
    ffmpeg.once('close', (code) => {
      if (settled) return
      if (code !== 0) {
        fail(new Error(`CosyVoice ffmpeg exited with code ${code}`))
        return
      }
      if (outputBytes === 0) {
        fail(new Error('CosyVoice ffmpeg completed with zero audio bytes'))
        return
      }
      settled = true
      output.end()
    })

    const cleanup = () => {
      if (!ffmpeg.killed) ffmpeg.kill()
    }
    output.once('close', cleanup)
    return output
  }
}
