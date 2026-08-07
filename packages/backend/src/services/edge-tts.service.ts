import fs from 'fs/promises'
import { fileExist, readJson, safeRunWithRetry } from '../utils'
import { ttsPluginManager } from '../tts/pluginManager'
import { DEFAULT_ENGINE } from '../config'
import { logger } from '../utils/logger'
import { safeErrorMetadata } from '../utils/diagnostics'

export const generateSingleVoice = async (params: {
  text: string
  pitch?: string
  voice: string
  rate?: string
  volume?: string
  output: string
  engine?: string
  instruction?: string
  onRetry?: (attempt: number) => void
}) => {
  const {
    text,
    pitch,
    voice,
    rate,
    volume,
    output,
    engine = DEFAULT_ENGINE,
    instruction,
    onRetry,
  } = params
  let result: TTSResult = {
    audio: '',
    srt: '',
  }
  await safeRunWithRetry(
    async () => {
      const engineInstance = ttsPluginManager.getEngine(engine)
      if (!engineInstance) {
        throw new Error(`TTS engine not found: ${engine}`)
      }
      const buffer = (await engineInstance.synthesize(text, {
        voice,
        pitch: pitch != null ? pitch : undefined,
        rate: rate != null ? rate : undefined,
        volume: volume != null ? volume : undefined,
        stream: false,
        outputType: 'buffer',
        saveSubtitles: engineInstance.supportsSubtitles !== false,
        output,
        instruction,
      } as any)) as Buffer
      await fs.writeFile(output, buffer)
      result = {
        audio: output,
        srt: output.replace('.mp3', '.srt'),
      }
    },
    { retries: 5, onRetry }
  )
  return result!
}
export const generateSingleVoiceStream = async (params: {
  text: string
  pitch?: string
  voice: string
  rate?: string
  volume?: string
  output: string
  outputType?: string
  engine?: string
  instruction?: string
}) => {
  const { text, pitch, voice, rate, volume, output, engine = DEFAULT_ENGINE, instruction } = params
  const engineInstance = ttsPluginManager.getEngine(engine)
  if (!engineInstance) {
    throw new Error(`TTS engine not found: ${engine}`)
  }
  return engineInstance.synthesize(text, {
    voice,
    pitch: pitch != null ? pitch : undefined,
    rate: rate != null ? rate : undefined,
    volume: volume != null ? volume : undefined,
    stream: true,
    outputType: 'stream',
    saveSubtitles: engineInstance.supportsSubtitles !== false,
    output,
    instruction,
  } as any)
}

// 定义字幕数据的类型
interface Subtitle {
  part: string // 字幕文本
  start: number // 开始时间（毫秒）
  end: number // 结束时间（毫秒）
}

/**
 * 将毫秒转换为 SRT 时间格式（HH:MM:SS,MMM）
 * @param ms 毫秒数
 * @returns 格式化的时间字符串
 */
function formatTime(ms: number): string {
  const hours = Math.floor(ms / 3600000)
    .toString()
    .padStart(2, '0')
  const minutes = Math.floor((ms % 3600000) / 60000)
    .toString()
    .padStart(2, '0')
  const seconds = Math.floor((ms % 60000) / 1000)
    .toString()
    .padStart(2, '0')
  const milliseconds = (ms % 1000).toString().padStart(3, '0')
  return `${hours}:${minutes}:${seconds},${milliseconds}`
}

/**
 * 将字幕 JSON 数据转换为 SRT 格式字符串
 * @param subtitles 字幕数组
 * @returns SRT 格式的字符串
 */
function convertToSrt(subtitles: Subtitle[]): string {
  let srtContent = ''

  subtitles.forEach((subtitle, index) => {
    const startTime = formatTime(subtitle.start)
    const endTime = formatTime(subtitle.end)

    srtContent += `${index + 1}\n`
    srtContent += `${startTime} --> ${endTime}\n`
    srtContent += `${subtitle.part}\n\n`
  })

  return srtContent
}

export const jsonToSrt = async (jsonPath: string) => {
  const json = await readJson<any>(jsonPath)
  const srtResult = convertToSrt(json)
  return srtResult
}

export const generateSrt = async (jsonPath: string, srtPath: string, deleteJson = false) => {
  if (await fileExist(srtPath)) {
    logger.debug('SRT file already exists')
    return
  }
  try {
    const srtTxt = await jsonToSrt(jsonPath)
    await fs.writeFile(srtPath, srtTxt, 'utf8')
    logger.debug('SRT file created')
    if (deleteJson) await fs.unlink(jsonPath)
    return srtPath
  } catch (err) {
    logger.error('SRT generation failed', { error: safeErrorMetadata(err) })
    return
  }
}
