import { Readable } from 'stream'

export interface TtsOptions {
  speed?: number // 语速，0.25-4.0
  rate?: number | string // 语速，0.25-4.0 or a percentage adjustment
  pitch?: number | string // 音调，-1.0 到 1.0 or a Hz adjustment
  volume?: number | string // 音量，0.0 到 1.0 or a percentage adjustment
  style?: string //  风格
  voice?: string // 音色名称
  format?: string // 音频格式
  language?: string // 语言代码，如 "en-US"
  stream?: boolean // 是否流式返回音频数据
  outputType?: string // buffer | stream | file
  output?: string // output path
  saveSubtitles?: boolean // saveSubtitles
  instruction?: string // Qwen-Audio-TTS 指令控制（方言、情感风格等）
}

export interface TTSEngine {
  name: string // 引擎名称
  cacheNamespace?: string // Engine/model revision used to isolate synthesized audio caches
  outputFormat?: string
  sampleRate?: number
  synthesize(text: string, options: TtsOptions): Promise<Buffer | Readable> // 合成语音，返回音频 Buffer 或者 Readable
  getSupportedLanguages(): Promise<string[]> // 支持的语言列表
  getVoiceOptions?(): Promise<(string | Record<string, unknown>)[]> // 可选：支持的音色列表
  supportsSubtitles?: boolean // 是否支持字幕生成，默认 true
  initialize?(): Promise<void> // 可选：初始化方法
}
