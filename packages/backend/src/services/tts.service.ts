import path from 'path'
import fs from 'fs/promises'
import { AUDIO_DIR, STATIC_DOMAIN, EDGE_API_LIMIT } from '../config'
import { logger } from '../utils/logger'
import { getPrompt } from '../llm/prompt/generateSegment'
import { ensureDir, generateId, getLangConfig } from '../utils'
import { ttsPluginManager } from '../tts/pluginManager'
import { DEFAULT_ENGINE } from '../config'
import { openai } from '../utils/openai'
import { splitText } from './text.service'
import { generateSingleVoice } from './edge-tts.service'
import { EdgeSchema } from '../schema/generate'
import { MapLimitController } from '../controllers/concurrency.controller'
import audioCacheInstance from './audioCache.service'
import { Task } from '../utils/taskManager'
import { handleSrt } from './tts.stream.service'
import { createSynthesisCacheKey } from './synthesisCache'
import { resolveRecommendationVoices } from './recommendationVoices'
import {
  createGenerationDiagnostics,
  GenerationDiagnostics,
} from '../utils/diagnostics'
import {
  assembleBuildSegmentAudio,
  assembleBuildSegmentSubtitles,
  TimelineBuildSegmentAudio,
} from './buildSegmentAssembly.service'
import { normalizeRecommendationSegments } from './recommendationInterruptions'

// 错误消息枚举
export enum ErrorMessages {
  ENG_MODEL_INVALID_TEXT = 'English model cannot process non-English text',
  API_FETCH_FAILED = 'Failed to fetch TTS parameters from API',
  INVALID_API_RESPONSE = 'Invalid API response: no TTS parameters returned',
  PARAMS_PARSE_FAILED = 'Failed to parse TTS parameters',
  INVALID_PARAMS_FORMAT = 'Invalid TTS parameters format',
  TTS_GENERATION_FAILED = 'TTS generation failed',
  INCOMPLETE_RESULT = 'Incomplete TTS result',
}

/**
 * 生成文本转语音 (TTS) 的音频和字幕
 */
export async function generateTTS(
  params: Required<EdgeSchema>,
  task?: Task,
  diagnostics: GenerationDiagnostics = createGenerationDiagnostics()
): Promise<TTSResult> {
  const {
    text,
    pitch,
    voice,
    rate,
    volume,
    useLLM,
    engine,
    instruction,
    enableInterruptions,
  } = params
  // 检查缓存
  const cacheKey = createSynthesisCacheKey(params)
  const cache = await audioCacheInstance.getAudio(cacheKey)
  if (cache) {
    diagnostics.segmentCount = 1
    logger.info('TTS cache hit', { engine, voice, textLength: text.length })
    return cache
  }

  const segment: Segment = { id: generateId(`${useLLM ? 'aigen-' : voice}`, text), text }
  const { lang, voiceList } = await getLangConfig(segment.text)
  logger.debug(`Language detected lang: `, lang)
  if (!useLLM) validateLangAndVoice(lang, voice)

  let result: TTSResult
  if (useLLM) {
    result = await generateWithLLM(
      segment,
      voiceList,
      lang,
      engine,
      enableInterruptions,
      diagnostics,
      task
    )
  } else {
    result = await generateWithoutLLM(
      segment,
      {
        text,
        pitch,
        voice,
        rate,
        volume,
        output: segment.id,
        engine,
        instruction,
      },
      diagnostics,
      task
    )
  }

  // 验证结果并缓存
  validateTTSResult(result, segment.id)
  logger.info('TTS generation completed', { engine, partial: result.partial === true })
  if (result.partial) {
    logger.warn(`Partial result detected, some splits generated audio failed!`)
  } else {
    await audioCacheInstance.setAudio(cacheKey, { ...params, ...result })
  }
  return result
}

/**
 * 使用 LLM 生成 TTS
 */
async function generateWithLLM(
  segment: Segment,
  voiceList: VoiceConfig[],
  lang: string,
  engine: string,
  enableInterruptions: boolean,
  diagnostics: GenerationDiagnostics,
  task?: Task
): Promise<TTSResult> {
  const { text, id } = segment
  const { length, segments } = splitText(text.trim())

  const effectiveVoiceList = await resolveRecommendationVoices(engine, voiceList)

  const formatLlmSegments = (llmSegments: any) =>
    normalizeRecommendationSegments(llmSegments, enableInterruptions)
      .filter((segment: any) => segment.text)
      .map((segment: any) => ({
        ...segment,
        voice: segment.name,
        engine,
      }))
  if (length <= 1) {
    const prompt = getPrompt(lang, effectiveVoiceList, segments[0], engine, enableInterruptions)
    // logger.debug(`Prompt for LLM: ${prompt}`)
    const llmResponse = await fetchLLMSegment(prompt)
    let llmSegments = llmResponse?.result || llmResponse?.segments || []
    if (!Array.isArray(llmSegments)) {
      task?.endTask?.(task.id)
      throw new Error(
        'LLM response is not an array, please switch to Edge TTS mode or use another model'
      )
    }
    const formattedSegments = formatLlmSegments(llmSegments)
    diagnostics.segmentCount = formattedSegments.length
    logger.info('LLM Recommendation segmented content', {
      engine,
      segmentCount: formattedSegments.length,
    })
    const result = await buildSegmentList(segment, formattedSegments, diagnostics, task)
    task?.updateProgress?.(task.id, 100)
    return result
  } else {
    logger.info('Splitting text into multiple segments:', segments.length)
    let finalSegments = []
    let count = 0
    const getProgress = () => {
      return Number(((count / segments.length) * 100).toFixed(2))
    }
    for (let seg of segments) {
      count++
      const prompt = getPrompt(lang, effectiveVoiceList, seg, engine, enableInterruptions)
      // logger.debug(`Prompt for LLM: ${prompt}`)
      const llmResponse = await fetchLLMSegment(prompt)
      let llmSegments = llmResponse?.result || llmResponse?.segments || []
      if (!Array.isArray(llmSegments)) {
        throw new Error(
          'LLM response is not an array, please switch to Edge TTS mode or use another model'
        )
      }
      const formattedSegments = formatLlmSegments(llmSegments)
      diagnostics.segmentCount += formattedSegments.length
      logger.info('LLM Recommendation segmented content', {
        engine,
        batch: count,
        batchCount: segments.length,
        segmentCount: formattedSegments.length,
      })
      const result = await buildSegmentList(
        { ...segment, id: `[segments:${count}]${segment.id}` },
        formattedSegments,
        diagnostics,
        task
      )
      task?.updateProgress?.(task.id, getProgress())
      finalSegments.push(result)
    }
    return await buildFinal(finalSegments, id, engine)
  }
}
const buildFinal = async (finalSegments: TTSResult[], id: string, engine?: string) => {
  // Check if engine supports subtitles before trying to Concat
  const engInstance = engine ? ttsPluginManager.getEngine(engine) : undefined
  const supportsSrt = engInstance?.supportsSubtitles !== false
  const finalDir = path.resolve(AUDIO_DIR, id.replace('.mp3', ''))
  const outputFile = path.resolve(AUDIO_DIR, id)
  await ensureDir(finalDir)

  if (supportsSrt) {
    const jsonFiles = finalSegments.map((file) => {
      const base = path.basename(file.audio)
      return path.resolve(AUDIO_DIR, base.replace('.mp3', ''), 'all_splits.mp3.json')
    })
    await assembleBuildSegmentSubtitles({
      inputDir: finalDir,
      outputFile,
      jsonFiles,
      metadataFileName: '[merged]all_splits.mp3.json',
    })
  }
  const fileList = finalSegments.map((segment) =>
    path.resolve(AUDIO_DIR, path.parse(segment.audio).base)
  )
  await assembleBuildSegmentAudio({
    strategy: 'concat',
    segments: fileList.map((audioFile) => ({ audioFile })),
    inputDir: finalDir,
    outputFile,
  })
  return {
    audio: `${STATIC_DOMAIN}/${id}`,
    srt: supportsSrt ? `${STATIC_DOMAIN}/${id.replace('.mp3', '.srt')}` : '',
  }
}
/**
 * 不使用 LLM 生成 TTS
 */
async function generateWithoutLLM(
  segment: Segment,
  params: TTSParams,
  diagnostics: GenerationDiagnostics,
  task?: Task
): Promise<TTSResult> {
  const { text, pitch, voice, rate, volume } = params
  const { length, segments } = splitText(text)
  diagnostics.segmentCount = length

  if (length <= 1) {
    return buildSegment(segment, params, diagnostics)
  } else {
    const buildSegments = segments.map((segment) => ({ ...params, text: segment }))
    let result = await buildSegmentList(segment, buildSegments, diagnostics, task)
    task?.updateProgress?.(task.id, 100)
    return result
  }
}

/**
 * 生成单个片段的音频和字幕
 */
async function buildSegment(
  segment: Segment,
  params: TTSParams,
  diagnostics: GenerationDiagnostics,
  dir: string = ''
): Promise<TTSResult> {
  const { id, text } = segment
  const { pitch, voice, rate, volume, engine, instruction } = params
  const output = path.resolve(AUDIO_DIR, dir, id)
  const result = await generateSingleVoice({
    text,
    pitch,
    voice,
    rate,
    volume,
    output,
    engine,
    instruction,
    onRetry: () => diagnostics.retryCount++,
  })
  logger.info('Generated single Segment', { engine, voice })
  const engineInstance = ttsPluginManager.getEngine(engine || DEFAULT_ENGINE)
  if (engineInstance?.supportsSubtitles !== false) {
    setTimeout(() => {
      handleSrt(output, false)
    }, 200)
  }
  return {
    audio: `${STATIC_DOMAIN}/${path.join(dir, id)}`,
    srt: `${STATIC_DOMAIN}/${path.join(dir, id.replace('.mp3', '.srt'))}`,
  }
}

/**
 * 生成多个片段并合并的 TTS
 */
async function buildSegmentList(
  segment: Segment,
  segments: BuildSegment[],
  diagnostics: GenerationDiagnostics,
  task?: Task
): Promise<TTSResult> {
  const length = segments.length
  let handledLength = 0

  if (!length) {
    throw new Error(`No segments found for task ${task?.id || 'unknown'}!`)
  }
  const { id } = segment
  const tmpDirName = id.replace('.mp3', '')
  const tmpDirPath = path.resolve(AUDIO_DIR, tmpDirName)
  await ensureDir(tmpDirPath)
  await fs.writeFile(
    path.resolve(tmpDirPath, 'ai-segments.json'),
    JSON.stringify(segments, null, 2)
  )
  const getProgress = () => {
    return Number((((handledLength / length) * 100) / (id.includes('segment') ? 2 : 1)).toFixed(2))
  }
  const tasks = segments.map((segment, index) => async () => {
    const { text, pitch, voice, rate, volume, engine, instruction } = segment
    const output = path.resolve(tmpDirPath, `${index + 1}_splits.mp3`)
    const cacheKey = createSynthesisCacheKey(segment)
    const cache = await audioCacheInstance.getAudio(cacheKey)
    if (cache) {
      logger.info('Segment cache hit', { engine, voice, textLength: text.length })
      return cache
    }
    const result = await generateSingleVoice({
      text,
      pitch,
      voice,
      rate,
      volume,
      output,
      engine,
      instruction,
      onRetry: () => diagnostics.retryCount++,
    })
    logger.debug('Segment cache miss', { engine, voice })
    handledLength++
    task?.updateProgress?.(task.id, getProgress())
    const params = { text, pitch, voice, rate, volume, engine, instruction }
    await audioCacheInstance.setAudio(cacheKey, { ...params, ...result })
    return result
  })
  let partial = false
  const results = await runConcurrentTasks(tasks, EDGE_API_LIMIT)
  if (results?.some((result) => !result.success)) {
    logger.warn('Partial result detected; some Segments failed', {
      failedSegmentCount: results.filter((result) => !result.success).length,
    })
    partial = true
  }
  const generatedSegments: TimelineBuildSegmentAudio[] = results.flatMap((result, index) => {
    if (!result.success) return []
    const buildSegment = segments[index]
    return [
      {
        audioFile: result.value.audio as string,
        interrupt: buildSegment.interrupt === true,
        overlapMs: buildSegment.overlapMs || 0,
        duckPreviousDb: buildSegment.duckPreviousDb || 0,
      },
    ]
  })
  const fileList = generatedSegments.map((segment) => segment.audioFile)
  const outputFile = path.resolve(AUDIO_DIR, id)
  const hasEffectiveInterruption = generatedSegments.some(
    (segment, index) => index > 0 && segment.interrupt && segment.overlapMs > 0
  )
  logger.debug('Assembling Segment audio', {
    segmentCount: fileList.length,
    strategy: hasEffectiveInterruption ? 'timeline-mix' : 'concat',
  })
  if (hasEffectiveInterruption) {
    await assembleBuildSegmentAudio({
      strategy: 'timeline-mix',
      segments: generatedSegments,
      inputRoot: AUDIO_DIR,
      outputFile,
    })
  } else {
    await assembleBuildSegmentAudio({
      strategy: 'concat',
      segments: generatedSegments,
      inputDir: tmpDirPath,
      outputFile,
    })
  }
  // Skip subtitle concatenation if engine doesn't support subtitles (e.g. CosyVoice, Qwen-Audio-TTS)
  const firstEngine = segments[0]?.engine || DEFAULT_ENGINE
  const engInstance = ttsPluginManager.getEngine(firstEngine)
  if (engInstance?.supportsSubtitles !== false) {
    await assembleBuildSegmentSubtitles({ inputDir: tmpDirPath, audioFiles: fileList, outputFile })
    logger.debug('Concatenating Segment subtitles', { segmentCount: fileList.length })
  }

  return {
    audio: `${STATIC_DOMAIN}/${id}`,
    srt: `${STATIC_DOMAIN}/${id.replace('.mp3', '.srt')}`,
    partial,
  }
}

/**
 * 并发执行任务
 */
async function runConcurrentTasks(tasks: (() => Promise<any>)[], limit: number): Promise<any[]> {
  logger.debug(`Running ${tasks.length} tasks with a limit of ${limit}`)
  const controller = new MapLimitController(tasks, limit, () =>
    logger.info('All concurrent tasks completed')
  )
  const { results, cancelled } = await controller.run()
  logger.info(`Tasks completed: ${results.length}, cancelled: ${cancelled}`)
  return results
}

/**
 * 验证语言和语音参数
 */
function validateLangAndVoice(lang: string, voice: string): void {
  if (lang !== 'eng' && voice.startsWith('en')) {
    throw new Error(ErrorMessages.ENG_MODEL_INVALID_TEXT)
  }
}

/**
 * 从 LLM 获取分段参数
 */
async function fetchLLMSegment(prompt: string): Promise<any> {
  const response = await openai.createChatCompletion({
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant. And you can return valid json object',
      },
      { role: 'user', content: prompt },
    ],
    // temperature: 0.7,
    // max_tokens: 500,
    response_format: { type: 'json_object' },
  })

  if (!response.choices[0].message.content) {
    throw new Error(ErrorMessages.INVALID_API_RESPONSE)
  }
  return parseLLMResponse(response)
}

/**
 * 解析 LLM 响应
 */
function parseLLMResponse(response: any): TTSParams {
  const params = JSON.parse(response.choices[0].message.content) as TTSParams
  if (!params || typeof params !== 'object') {
    throw new Error(ErrorMessages.INVALID_PARAMS_FORMAT)
  }
  return params
}

/**
 * 验证 TTS 结果
 */
function validateTTSResult(result: TTSResult, segmentId: string): void {
  if (!result.audio) {
    throw new Error(`${ErrorMessages.INCOMPLETE_RESULT} for segment ${segmentId}`)
  }
}
