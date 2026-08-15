import path, { resolve } from 'path'
import { Response } from 'express'
import fs, { readdir } from 'fs/promises'
import { createReadStream, createWriteStream } from 'fs'
import { AUDIO_DIR, STATIC_DOMAIN } from '../config'
import { logger } from '../utils/logger'
import { getPrompt } from '../llm/prompt/generateSegment'
import {
  asyncSleep,
  ensureDir,
  generateId,
  getLangConfig,
  streamToResponse,
} from '../utils'
import { ttsPluginManager } from '../tts/pluginManager'
import { DEFAULT_ENGINE } from '../config'
import { openai } from '../utils/openai'
import { splitText } from './text.service'
import { generateSingleVoiceStream, generateSrt } from './edge-tts.service'
import { EdgeSchema } from '../schema/generate'
import audioCacheInstance from './audioCache.service'
import taskManager, { Task } from '../utils/taskManager'
import { Readable, PassThrough } from 'stream'
import { pipeline } from 'stream/promises'
import {
  createFinalAudioCacheDescriptor,
  createSynthesisCacheKey,
} from './synthesisCache'
import {
  enforceRecommendationVoices,
  resolveRecommendationVoices,
} from './recommendationVoices'
import { audioByteLength, generationRuntimeMetadata } from '../utils/diagnostics'
import {
  assembleBuildSegmentAudio,
  assembleBuildSegmentSubtitles,
  GeneratedStreamBuildSegmentAudio,
  TimelineBuildSegmentAudio,
} from './buildSegmentAssembly.service'
import {
  normalizeTimelineControlSegments,
  prepareTimelineControlSourceText,
} from './recommendationInterruptions'
import { logAudioGenerationJson } from '../utils/audioGenerationLog'

// 错误消息枚举
enum ErrorMessages {
  ENG_MODEL_INVALID_TEXT = 'English model cannot process non-English text',
  API_FETCH_FAILED = 'Failed to fetch TTS parameters from API',
  INVALID_API_RESPONSE = 'Invalid API response: no TTS parameters returned',
  PARAMS_PARSE_FAILED = 'Failed to parse TTS parameters',
  INVALID_PARAMS_FORMAT = 'Invalid TTS parameters format',
  TTS_GENERATION_FAILED = 'TTS generation failed',
  INCOMPLETE_RESULT = 'Incomplete TTS result',
}

/**
 * 流式生成文本转语音 (TTS) 的音频和字幕
 */
export async function generateTTSStream(params: Required<EdgeSchema>, task: Task) {
  const { text, pitch, voice, rate, volume, useLLM, engine } = params
  const segment: Segment = { id: generateId(useLLM ? 'aigen-' : voice, text), text }
  const { lang, voiceList } = await getLangConfig(segment.text)
  logger.debug(`Language detected lang: `, lang)

  const effectiveVoiceList = await resolveRecommendationVoices(engine, voiceList)

  task!.context!.segment = segment
  task!.context!.lang = lang
  task!.context!.voiceList = effectiveVoiceList
  task!.context!.engine = engine
  const { res } = task.context as Required<NonNullable<Task['context']>>
  if (!useLLM && !validateLangAndVoice(lang, voice, res)) {
    taskManager.failTask(
      task.id,
      { message: ErrorMessages.ENG_MODEL_INVALID_TEXT, code: 400 },
      task
    )
    return
  }

  // 检查缓存, 如果有缓存则直接返回
  const cacheKey = createSynthesisCacheKey(params)
  const cache = useLLM ? null : await audioCacheInstance.getAudio(cacheKey)
  if (cache) {
    const data = {
      ...cache,
      file: path.parse(cache.audio).base,
      srt: path.parse(cache.srt).base,
      text: '',
    }
    logger.info('TTS stream cache hit', { engine, voice, textLength: text.length })
    if (task.context?.diagnostics) {
      task.context.diagnostics.segmentCount = 1
      task.context.diagnostics.audioBytes = await audioByteLength(AUDIO_DIR, cache.audio)
    }
    task.context?.res?.setHeader('x-generate-tts-type', 'application/json')
    task.context?.res?.setHeader('Access-Control-Expose-Headers', 'x-generate-tts-type')
    task.context?.res?.json({ code: 200, data, success: true })
    task.endTask?.(task.id)
    logStreamCompletion(task, task.context?.res)
    return
  }

  if (useLLM) {
    await generateWithLLMStream(task)
  } else {
    await generateWithoutLLMStream({ ...params, output: segment.id, engine }, task)
  }
}
export async function generateTTSStreamJson(formatedBody: Required<EdgeSchema>[], task: Task) {
  const { segment } = task.context as Required<NonNullable<Task['context']>>
  const output = path.resolve(AUDIO_DIR, segment.id)
  const segments = formatedBody
  logger.info(`generateTTSStreamJson splitText length: ${formatedBody.length} `)
  const buildSegments = segments.map((segment) => ({ ...segment, output }))
  await buildSegmentList(buildSegments, task)
}

/**
 * 使用 LLM 生成 TTS
 */
async function generateWithLLMStream(task: Task) {
  const { segment, voiceList, lang, engine } = task.context as Required<NonNullable<Task['context']>>
  const enableInterruptions = task.fields.enableInterruptions === true
  const { text, id } = segment
  const timelineControlSource = prepareTimelineControlSourceText(text.trim())
  const { length, segments } = splitText(timelineControlSource.text)
  const toBuildSegments = (llmSegments: any[]) =>
    enforceRecommendationVoices(llmSegments, voiceList)
      .filter((segment: any) => segment.text)
      .map((segment: any) => ({
        ...segment,
        voice: segment.name,
        engine,
      }))
  const recommendBuildSegments = async (textSegment: string): Promise<BuildSegment[]> => {
    const prompt = getPrompt(lang, voiceList, textSegment, engine, enableInterruptions)
    const llmResponse = await fetchLLMSegment(prompt)
    const llmSegments = llmResponse?.result || llmResponse?.segments || []
    if (!Array.isArray(llmSegments)) {
      throw new Error(
        'LLM response is not an array, please switch to Edge TTS mode or use another model'
      )
    }
    return toBuildSegments(llmSegments)
  }
  const recommendNormalizedBuildSegments = async (
    textSegment: string,
    includeSourceDirectives = false
  ): Promise<BuildSegment[]> =>
    normalizeTimelineControlSegments(
      await recommendBuildSegments(textSegment),
      enableInterruptions,
      includeSourceDirectives ? timelineControlSource : undefined
    ) as unknown as BuildSegment[]

  if (length <= 1) {
    const formattedSegments = await recommendNormalizedBuildSegments(segments[0], true)
    if (task.context?.diagnostics) {
      task.context.diagnostics.segmentCount = formattedSegments.length
    }
    logger.info('Streaming LLM Recommendation segmented content', {
      engine,
      segmentCount: formattedSegments.length,
    })
    await assembleRecommendedSegments(formattedSegments, task)
  } else {
    const output = resolve(AUDIO_DIR, id)
    let count = 0
    logger.info('Splitting text into multiple segments:', segments.length)
    const getProgress = () => {
      return Number(((count / segments.length) * 100).toFixed(2))
    }
    if (enableInterruptions) {
      const recommendedSegments: any[] = []
      for (const textSegment of segments) {
        count++
        const llmFormatted = await recommendBuildSegments(textSegment)
        recommendedSegments.push(...llmFormatted)
        if (task.context?.diagnostics) {
          task.context.diagnostics.segmentCount += llmFormatted.length
        }
        logger.info('Buffered LLM Recommendation segmented content', {
          engine,
          batch: count,
          batchCount: segments.length,
          segmentCount: llmFormatted.length,
        })
        logger.info(`Progress: ${getProgress()}%`)
      }
      await assembleRecommendedSegments(
        normalizeTimelineControlSegments(
          recommendedSegments,
          true,
          timelineControlSource
        ) as unknown as BuildSegment[],
        task
      )
      return
    }

    async function* generatedAudio(): AsyncGenerator<GeneratedStreamBuildSegmentAudio> {
      for (const textSegment of segments) {
        count++
        const llmFormatted = await recommendNormalizedBuildSegments(textSegment)
        logAudioGenerationJson(llmFormatted)
        if (task.context?.diagnostics) {
          task.context.diagnostics.segmentCount += llmFormatted.length
        }
        logger.info('Streaming LLM Recommendation segmented content', {
          engine,
          batch: count,
          batchCount: segments.length,
          segmentCount: llmFormatted.length,
        })
        for (const buildSegment of llmFormatted) {
          yield {
            audioStream: (await generateSingleVoiceStream({
              ...buildSegment,
              output,
              outputType: 'stream',
            })) as Readable,
          }
        }
        logger.info(`Progress: ${getProgress()}%`)
      }
    }

    const engineInstance = ttsPluginManager.getEngine(engine || DEFAULT_ENGINE)
    await streamAssembledBuildSegments(
      task,
      output,
      generatedAudio(),
      engineInstance?.supportsSubtitles !== false
    )
  }
}

async function assembleRecommendedSegments(segments: BuildSegment[], task: Task): Promise<void> {
  logAudioGenerationJson(segments)
  const finalCache = createFinalAudioCacheDescriptor({
    enableInterruptions: true,
    segments,
    sourceText: task.context?.segment?.text,
    recommendationModel: task.fields?.recommendationModel,
  })
  if (finalCache.identity.mode !== 'timeline-mix') {
    await buildSegmentList(segments, task)
    return
  }

  const cachedFinalAudio = await audioCacheInstance.getAudio(finalCache.key)
  if (cachedFinalAudio) {
    const cachedAudioFile = path.resolve(AUDIO_DIR, path.basename(cachedFinalAudio.audio))
    const cachedAudioStat = await fs.stat(cachedAudioFile).catch(() => undefined)
    if (cachedAudioStat?.isFile() && cachedAudioStat.size > 0) {
      if (task.context?.diagnostics) {
        task.context.diagnostics.segmentCount = segments.length
        task.context.diagnostics.generationMode = finalCache.identity.mode
        task.context.diagnostics.effectiveInterruptionCount = finalCache.identity.timeline.filter(
          (item) => item.interrupt
        ).length
        task.context.diagnostics.effectivePauseCount = finalCache.identity.timeline.filter(
          (item) => item.type === 'pause'
        ).length
        task.context.diagnostics.effectivePauseDurationMs = finalCache.identity.timeline.reduce(
          (total, item) => total + item.pauseDurationMs,
          0
        )
        task.context.diagnostics.audioBytes = 0
      }
      streamTaskToResponse(task, createReadStream(cachedAudioFile), {
        mode: 'buffered-timeline',
        contentType: 'audio/mpeg',
      })
      return
    }
  }

  await bufferTimelineBuildSegments(segments, task, finalCache)
}

async function bufferTimelineBuildSegments(
  segments: BuildSegment[],
  task: Task,
  finalCache: ReturnType<typeof createFinalAudioCacheDescriptor>
): Promise<void> {
  const { segment } = task.context as Required<NonNullable<Task['context']>>
  const signal = task.context?.abortSignal
  const outputFile = path.resolve(AUDIO_DIR, segment.id)
  const inputDir = `${outputFile}.timeline-inputs`
  const pendingStableFiles: string[] = []
  await ensureDir(inputDir)

  try {
    if (task.context?.diagnostics) {
      task.context.diagnostics.generationMode = 'timeline-mix'
      task.context.diagnostics.effectiveInterruptionCount = finalCache.identity.timeline.filter(
        (item) => item.interrupt
      ).length
      task.context.diagnostics.effectivePauseCount = finalCache.identity.timeline.filter(
        (item) => item.type === 'pause'
      ).length
      task.context.diagnostics.effectivePauseDurationMs = finalCache.identity.timeline.reduce(
        (total, item) => total + item.pauseDurationMs,
        0
      )
    }
    const generatedSegments: TimelineBuildSegmentAudio[] = []
    const subtitleJsonFiles: string[] = []
    const supportsSubtitles = buildSegmentsSupportSubtitles(segments)
    const segmentCacheDir = path.resolve(AUDIO_DIR, '.segment-cache')
    for (const [index, buildSegment] of segments.entries()) {
      signal?.throwIfAborted()
      const audioFile = path.join(inputDir, `${String(index + 1).padStart(6, '0')}.mp3`)
      const segmentCacheKey = createSynthesisCacheKey(buildSegment)
      const cachedSegment = await audioCacheInstance.getAudio(segmentCacheKey)
      const cachedAudioFile = cachedSegment
        ? path.isAbsolute(cachedSegment.audio)
          ? cachedSegment.audio
          : path.resolve(AUDIO_DIR, path.basename(cachedSegment.audio))
        : undefined
      const cachedAudioStat = cachedAudioFile
        ? await fs.stat(cachedAudioFile).catch(() => undefined)
        : undefined
      if (cachedAudioStat?.isFile() && cachedAudioStat.size > 0) {
        generatedSegments.push({
          audioFile: cachedAudioFile!,
          timelineControl: buildSegment.timelineControl,
        })
        if (supportsSubtitles) subtitleJsonFiles.push(`${cachedAudioFile}.json`)
        continue
      }
      await synthesizeStreamToFileWithRetry(buildSegment, audioFile, signal, task, index)
      await ensureDir(segmentCacheDir)
      const stableAudioFile = path.join(segmentCacheDir, `${segmentCacheKey}.mp3`)
      const stableTemporaryFile = `${stableAudioFile}.${task.id}.${index}.tmp`
      pendingStableFiles.push(stableTemporaryFile)
      await fs.copyFile(audioFile, stableTemporaryFile)
      await fs.rename(stableTemporaryFile, stableAudioFile)
      pendingStableFiles.splice(pendingStableFiles.indexOf(stableTemporaryFile), 1)
      if (supportsSubtitles) {
        const subtitleJsonFile = await findStreamSubtitleJsonFile(audioFile)
        await fs.copyFile(subtitleJsonFile, `${stableAudioFile}.json`)
        subtitleJsonFiles.push(subtitleJsonFile)
      }
      await audioCacheInstance.setAudio(segmentCacheKey, {
        ...buildSegment,
        audio: stableAudioFile,
        srt: '',
      })
      generatedSegments.push({
        audioFile,
        timelineControl: buildSegment.timelineControl,
      })
    }

    const timelineResult = await assembleBuildSegmentAudio({
      strategy: 'timeline-mix',
      segments: generatedSegments,
      inputRoot: AUDIO_DIR,
      outputFile,
      signal,
    })
    if (task.context?.diagnostics) {
      task.context.diagnostics.mixDurationMs = timelineResult.mixDurationMs
    }
    if (supportsSubtitles) {
      await assembleBuildSegmentSubtitles({
        inputDir,
        outputFile,
        jsonFiles: subtitleJsonFiles,
        segmentStartsMs: timelineResult.segmentStartsMs,
        segmentTrimStartsMs: timelineResult.segmentTrimStartsMs,
        segmentDurationsMs: timelineResult.segmentDurationsMs,
      })
    }
    await audioCacheInstance.setAudio(finalCache.key, {
      ...segments[0],
      audio: `${STATIC_DOMAIN}/${path.basename(outputFile)}`,
      srt: supportsSubtitles
        ? `${STATIC_DOMAIN}/${path.parse(outputFile).name}.srt`
        : '',
    })
    streamTaskToResponse(task, createReadStream(outputFile), {
      mode: 'buffered-timeline',
      contentType: 'audio/mpeg',
      onCompleted: () => fs.rm(inputDir, { recursive: true, force: true }),
      onClosed: () => void fs.rm(inputDir, { recursive: true, force: true }),
    })
  } catch (error) {
    await Promise.all([
      fs.rm(inputDir, { recursive: true, force: true }),
      fs.unlink(outputFile).catch(() => undefined),
      fs.unlink(outputFile.replace('.mp3', '.srt')).catch(() => undefined),
      ...pendingStableFiles.map((file) => fs.unlink(file).catch(() => undefined)),
    ])
    throw error
  }
}

const MAX_STREAM_SYNTHESIS_ATTEMPTS = 3

async function synthesizeStreamToFileWithRetry(
  buildSegment: BuildSegment,
  audioFile: string,
  signal: AbortSignal | undefined,
  task: Task,
  segmentIndex: number
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_STREAM_SYNTHESIS_ATTEMPTS; attempt++) {
    signal?.throwIfAborted()
    await fs.unlink(audioFile).catch(() => undefined)
    try {
      const audioStream = (await generateSingleVoiceStream({
        ...buildSegment,
        output: audioFile,
        outputType: 'stream',
      })) as Readable
      await pipeline(audioStream, createWriteStream(audioFile), { signal })
      return
    } catch (error) {
      if (attempt === MAX_STREAM_SYNTHESIS_ATTEMPTS || signal?.aborted) {
        throw Object.assign(error as Error, { segmentIndex, attempt })
      }
      if (isPermanentDoubaoConfigurationError(error, buildSegment.engine)) {
        throw Object.assign(error as Error, { segmentIndex, attempt })
      }
      if (task.context?.diagnostics) task.context.diagnostics.retryCount++
      logger.warn('Segment streaming synthesis attempt failed', {
        engine: buildSegment.engine,
        segmentIndex,
        attempt,
        maxAttempts: MAX_STREAM_SYNTHESIS_ATTEMPTS,
      })
      await asyncSleep(1000)
    }
  }
}

function isPermanentDoubaoConfigurationError(error: unknown, engine?: string): boolean {
  if (engine !== 'doubao-tts' || !(error instanceof Error)) return false
  return /resource ID is mismatched|speaker related resource|invalidmodel|invalid speaker/i.test(
    error.message
  )
}

async function findStreamSubtitleJsonFile(audioFile: string): Promise<string> {
  const subtitleDir = `${audioFile}_tmp`
  const audioBase = path.basename(audioFile)
  const files = (await readdir(subtitleDir)).filter(
    (file) => file.startsWith(`${audioBase}.srt.json`) && !file.endsWith('.srt')
  )
  if (files.length !== 1) {
    throw new Error(`Expected one subtitle result for Build Segment: ${audioBase}`)
  }
  return path.join(subtitleDir, files[0])
}

async function generateWithoutLLMStream(params: TTSParams, task: Task) {
  const { segment } = task.context as Required<NonNullable<Task['context']>>
  const { text } = segment
  const { length, segments } = splitText(text)
  if (task.context?.diagnostics) task.context.diagnostics.segmentCount = length
  logger.info(`splitText length: ${length} `)
  if (length <= 1) {
    await buildSegment(params, task)
  } else {
    const buildSegments = segments.map((segment) => ({ ...params, text: segment }))
    await buildSegmentList(buildSegments, task)
  }
}

/**
 * 生成单个片段的音频和字幕
 */
async function buildSegment(params: TTSParams, task: Task, dir: string = '') {
  const { segment } = task.context as Required<NonNullable<Task['context']>>
  const output = path.resolve(AUDIO_DIR, dir, segment.id)
  const stream = (await generateSingleVoiceStream({
    ...params,
    output,
    outputType: 'stream',
  })) as Readable
  streamTaskToResponse(task, stream, {
    fileName: segment.id,
    onCompleted: () => {
      const engine = ttsPluginManager.getEngine(params.engine || DEFAULT_ENGINE)
      if (engine?.supportsSubtitles !== false) {
        setTimeout(() => {
          handleSrt(output)
        }, 200)
      }
    },
  })
}

/**
 * 生成多个片段并合并的 TTS
 */

interface SegmentError extends Error {
  segmentIndex: number
  attempt: number
}
export async function handleSrt(audioPath: string, stream = true) {
  if (!stream) {
    const tempJsonPath = audioPath + '.json'
    await generateSrt(tempJsonPath, audioPath.replace('.mp3', '.srt'))
    return
  }
  const { dir, base } = path.parse(audioPath)
  const tmpDir = audioPath + '_tmp'
  await ensureDir(tmpDir)

  const fileList = (await readdir(tmpDir))
    .filter((file) => file.includes(base) && file.includes('.json'))
    .sort((a, b) => Number(a.split('.json.')?.[1] || 0) - Number(b.split('.json.')?.[1] || 0))
    .map((file) => path.join(tmpDir, file))
  if (!fileList.length) return
  await assembleBuildSegmentSubtitles({
    jsonFiles: fileList,
    inputDir: tmpDir,
    outputFile: audioPath,
  })
}
async function buildSegmentList(segments: BuildSegment[], task: Task): Promise<void> {
  const { res, segment } = task.context as Required<NonNullable<Task['context']>>
  const { id: outputId } = segment
  const totalSegments = segments.length
  if (task.context?.diagnostics && task.context.diagnostics.segmentCount === 0) {
    task.context.diagnostics.segmentCount = totalSegments
  }
  const output = path.resolve(AUDIO_DIR, outputId)
  let completedSegments = 0
  if (!totalSegments) {
    taskManager.failTask(task.id, { message: 'No segments provided', code: 400 }, task)
    return void res.status(400).end('No segments provided')
  }

  const progress = () => Number(((completedSegments / totalSegments) * 100).toFixed(2))
  const supportsSubtitles = buildSegmentsSupportSubtitles(segments)

  async function* generatedAudio(
    maxRetries = 3
  ): AsyncGenerator<GeneratedStreamBuildSegmentAudio> {
    for (const [index, buildSegment] of segments.entries()) {
      const generateWithRetry = async (attempt = 0): Promise<Readable> => {
        try {
          return (await generateSingleVoiceStream({
            ...buildSegment,
            outputType: 'stream',
            output,
          })) as Readable
        } catch (err) {
          const error = err as Error
          if (attempt + 1 >= maxRetries) {
            throw Object.assign(error, {
              segmentIndex: index,
              attempt: attempt + 1,
            } as SegmentError)
          }
          if (task.context?.diagnostics) task.context.diagnostics.retryCount++
          logger.warn('Segment synthesis attempt failed', {
            engine: buildSegment.engine,
            segmentIndex: index,
            attempt: attempt + 1,
            maxRetries,
          })
          await asyncSleep(1000)
          return generateWithRetry(attempt + 1)
        }
      }

      try {
        // TODO: Concurrency of streaming flow
        const audioStream = await generateWithRetry()
        yield { audioStream }
        completedSegments++
        logger.info(`Segment ${index + 1}/${totalSegments} completed. Progress: ${progress()}%`)
      } catch (err) {
        const { segmentIndex, attempt } = err as SegmentError
        logger.error('Segment synthesis failed', {
          segmentIndex,
          retryCount: Math.max(0, attempt - 1),
        })
        throw err
      }
    }
  }

  await streamAssembledBuildSegments(task, output, generatedAudio(), supportsSubtitles)
}

function buildSegmentsSupportSubtitles(segments: Pick<BuildSegment, 'engine'>[]): boolean {
  return segments.every((item) => {
    const engine = ttsPluginManager.getEngine(item.engine || DEFAULT_ENGINE)
    return engine?.supportsSubtitles !== false
  })
}

async function streamAssembledBuildSegments(
  task: Task,
  outputFile: string,
  segments: AsyncIterable<GeneratedStreamBuildSegmentAudio>,
  supportsSubtitles: boolean
): Promise<void> {
  if (task.context?.diagnostics) task.context.diagnostics.generationMode = 'stream'
  const outputStream = new PassThrough()
  streamTaskToResponse(task, outputStream, {
    fileName: path.basename(outputFile),
    onCompleted: () => {
      if (supportsSubtitles) {
        return handleSrt(outputFile)
      }
    },
    onClosed: () => {
      void Promise.all([
        fs.unlink(outputFile).catch(() => undefined),
        fs.unlink(outputFile.replace('.mp3', '.srt')).catch(() => undefined),
      ])
    },
  })

  try {
    await assembleBuildSegmentAudio({
      strategy: 'stream',
      segments,
      output: outputStream,
    })
  } catch (error) {
    logger.error('Audio processing aborted')
    outputStream.destroy(error as Error)
  }
}

function streamTaskToResponse(
  task: Task,
  input: Readable,
  options: {
    fileName?: string
    mode?: 'stream' | 'buffered-timeline'
    contentType?: string
    onCompleted?: () => void | Promise<void>
    onClosed?: () => void | Promise<void>
  }
) {
  const { res } = task.context as Required<NonNullable<Task['context']>>
  input.on('data', (chunk) => {
    if (task.context?.diagnostics) {
      task.context.diagnostics.audioBytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(String(chunk))
    }
  })
  streamToResponse(res, input, {
    headers: res.headersSent
      ? {}
      : streamResponseHeaders(
          task,
          options.mode || 'stream',
          options.contentType || 'application/octet-stream'
        ),
    fileName: options.fileName,
    onError: (error) => {
      taskManager.failTask(task.id, { message: error.message }, task)
      return `TTS generation failed: ${error.message}`
    },
    onEnd: async () => {
      await options.onCompleted?.()
      taskManager.finishTask(task.id, task)
      logStreamCompletion(task, res)
    },
    onClose: () => {
      taskManager.cancelTask(task.id, 'Client disconnected', task)
      logger.info(`Streaming ${task.id} cancelled after client disconnect`)
      options.onClosed?.()
    },
  })
}

function streamResponseHeaders(
  task: Task,
  mode: 'stream' | 'buffered-timeline',
  contentType: string
) {
  return {
    'content-type': contentType,
    'x-generate-tts-type': mode,
    'x-generate-tts-id': task.id,
    'Access-Control-Expose-Headers': 'x-generate-tts-type, x-generate-tts-id',
  }
}

function logStreamCompletion(task: Task, res?: Response) {
  const diagnostics = task.context?.diagnostics
  logger.info('TTS stream completed', {
    correlationId: res?.locals?.correlationId || task.id,
    taskId: task.id,
    engine: task.context?.engine || task.fields?.engine,
    model: task.fields?.recommendationModel || '',
    ...generationRuntimeMetadata(diagnostics),
  })
}

/**
 * 验证语言和语音参数
 */
function validateLangAndVoice(lang: string, voice: string, res: Response): boolean {
  if (lang !== 'eng' && voice.startsWith('en')) {
    res.status(400).send({
      code: 400,
      success: false,
      message: ErrorMessages.ENG_MODEL_INVALID_TEXT,
    })
    return false
  }
  return true
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
