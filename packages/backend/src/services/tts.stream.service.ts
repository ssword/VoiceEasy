import path, { resolve } from 'path'
import { Response } from 'express'
import fs, { readdir } from 'fs/promises'
import ffmpeg from 'fluent-ffmpeg'
import { AUDIO_DIR, STATIC_DOMAIN, EDGE_API_LIMIT } from '../config'
import { logger } from '../utils/logger'
import { getPrompt } from '../llm/prompt/generateSegment'
import {
  asyncSleep,
  ensureDir,
  generateId,
  getLangConfig,
  readJson,
  streamToResponse,
} from '../utils'
import { ttsPluginManager } from '../tts/pluginManager'
import { DEFAULT_ENGINE } from '../config'
import { openai } from '../utils/openai'
import { splitText } from './text.service'
import { generateSingleVoiceStream, generateSrt } from './edge-tts.service'
import { EdgeSchema } from '../schema/generate'
import { MapLimitController } from '../controllers/concurrency.controller'
import audioCacheInstance from './audioCache.service'
import { mergeSubtitleFiles, SubtitleFile, SubtitleFiles } from '../utils/subtitle'
import taskManager, { Task } from '../utils/taskManager'
import { Readable, PassThrough } from 'stream'
import { createSynthesisCacheKey } from './synthesisCache'
import { resolveRecommendationVoices } from './recommendationVoices'
import { audioByteLength, generationRuntimeMetadata } from '../utils/diagnostics'

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
  const cache = await audioCacheInstance.getAudio(cacheKey)
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
  const { text, id } = segment
  const { length, segments } = splitText(text.trim())
  const formatLlmSegments = (llmSegments: any) =>
    llmSegments
      .filter((segment: any) => segment.text)
      .map((segment: any) => ({
        ...segment,
        voice: segment.name,
        engine,
      }))
  if (length <= 1) {
    const prompt = getPrompt(lang, voiceList, segments[0], engine)
    const llmResponse = await fetchLLMSegment(prompt)
    let llmSegments = llmResponse?.result || llmResponse?.segments || []
    if (!Array.isArray(llmSegments)) {
      throw new Error(
        'LLM response is not an array, please switch to Edge TTS mode or use another model'
      )
    }
    const formattedSegments = formatLlmSegments(llmSegments)
    if (task.context?.diagnostics) {
      task.context.diagnostics.segmentCount = formattedSegments.length
    }
    logger.info('Streaming LLM Recommendation segmented content', {
      engine,
      segmentCount: formattedSegments.length,
    })
    await buildSegmentList(formattedSegments, task)
  } else {
    const output = resolve(AUDIO_DIR, id)
    let count = 0
    logger.info('Splitting text into multiple segments:', segments.length)
    const getProgress = () => {
      return Number(((count / segments.length) * 100).toFixed(2))
    }
    const outputStream = new PassThrough()
    streamTaskToResponse(task, outputStream, {
      fileName: segment.id,
      onCompleted: () => {
        const engineInstance = ttsPluginManager.getEngine(engine || DEFAULT_ENGINE)
        if (engineInstance?.supportsSubtitles !== false) {
          setTimeout(() => {
            handleSrt(output)
          }, 200)
        }
      },
    })

    for (let seg of segments) {
      count++
      const prompt = getPrompt(lang, voiceList, seg, engine)
      const llmResponse = await fetchLLMSegment(prompt)
      let llmSegments = llmResponse?.result || llmResponse?.segments || []
      if (!Array.isArray(llmSegments)) {
        throw new Error(
          'LLM response is not an array, please switch to Edge TTS mode or use another model'
        )
      }
      const llmFormatted = formatLlmSegments(llmSegments)
      if (task.context?.diagnostics) {
        task.context.diagnostics.segmentCount += llmFormatted.length
      }
      logger.info('Streaming LLM Recommendation segmented content', {
        engine,
        batch: count,
        batchCount: segments.length,
        segmentCount: llmFormatted.length,
      })
      for (let segment of llmFormatted) {
        const stream = (await generateSingleVoiceStream({
          ...segment,
          output,
          outputType: 'stream',
        })) as Readable
        stream.pipe(outputStream, { end: false })
        await new Promise<void>((resolve, reject) => {
          stream.once('end', resolve)
          stream.once('error', reject)
        })
      }
      logger.info(`Progress: ${getProgress()}%`)
    }
    outputStream.end()
  }
}
const buildFinal = async (finalSegments: TTSResult[], id: string) => {
  const subtitleFiles: SubtitleFiles = await Promise.all(
    finalSegments.map((file) => {
      const base = path.basename(file.audio)
      const jsonPath = path.resolve(AUDIO_DIR, base.replace('.mp3', ''), 'all_splits.mp3.json')
      return readJson<SubtitleFile>(jsonPath)
    })
  )

  const mergedJson = mergeSubtitleFiles(subtitleFiles)
  const finalDir = path.resolve(AUDIO_DIR, id.replace('.mp3', ''))
  await ensureDir(finalDir)
  const finalJson = path.resolve(finalDir, '[merged]all_splits.mp3.json')
  await fs.writeFile(finalJson, JSON.stringify(mergedJson, null, 2))
  await generateSrt(finalJson, path.resolve(AUDIO_DIR, id.replace('.mp3', '.srt')))
  const fileList = finalSegments.map((segment) =>
    path.resolve(AUDIO_DIR, path.parse(segment.audio).base)
  )
  const outputFile = path.resolve(AUDIO_DIR, id)
  await concatDirAudio({ inputDir: finalDir, fileList, outputFile })
  return {
    audio: `${STATIC_DOMAIN}/${id}`,
    srt: `${STATIC_DOMAIN}/${id.replace('.mp3', '.srt')}`,
  }
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
  concatDirSrt({ jsonFiles: fileList, inputDir: tmpDir, outputFile: audioPath })
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
  const outputStream = new PassThrough()
  const supportsSubtitles = segments.every((item) => {
    const engine = ttsPluginManager.getEngine(item.engine || DEFAULT_ENGINE)
    return engine?.supportsSubtitles !== false
  })

  streamTaskToResponse(task, outputStream, {
    fileName: segment.id,
    onCompleted: () => {
      if (supportsSubtitles) {
        setTimeout(() => {
          handleSrt(output)
        }, 200)
      }
    },
  })

  const processSegment = async (index: number, maxRetries = 3): Promise<void> => {
    if (index >= totalSegments) {
      outputStream.end()
      return
    }

    const segment = segments[index]
    const generateWithRetry = async (attempt = 0): Promise<Readable> => {
      try {
        return (await generateSingleVoiceStream({
          ...segment,
          outputType: 'stream',
          output,
        })) as Readable
      } catch (err) {
        const error = err as Error
        if (attempt + 1 >= maxRetries) {
          throw Object.assign(error, { segmentIndex: index, attempt: attempt + 1 } as SegmentError)
        }
        if (task.context?.diagnostics) task.context.diagnostics.retryCount++
        logger.warn('Segment synthesis attempt failed', {
          engine: segment.engine,
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
      audioStream.pipe(outputStream, { end: false })
      await new Promise<void>((resolve, reject) => {
        audioStream.once('end', resolve)
        audioStream.once('error', reject)
      })
      completedSegments++
      logger.info(`Segment ${index + 1}/${totalSegments} completed. Progress: ${progress()}%`)
      await processSegment(index + 1)
    } catch (err) {
      const { segmentIndex, attempt, message } = err as SegmentError
      logger.error('Segment synthesis failed', {
        segmentIndex,
        retryCount: Math.max(0, attempt - 1),
      })
      outputStream.emit('error', err)
    }
  }

  try {
    await processSegment(0)
  } catch (err) {
    logger.error('Audio processing aborted')
    !res.headersSent && res.status(500).end('Internal server error')
  }
}

function streamTaskToResponse(
  task: Task,
  input: Readable,
  options: { fileName: string; onCompleted?: () => void }
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
    headers: {
      'content-type': 'application/octet-stream',
      'x-generate-tts-type': 'stream',
      'x-generate-tts-id': task.id,
      'Access-Control-Expose-Headers': 'x-generate-tts-type, x-generate-tts-id',
    },
    fileName: options.fileName,
    onError: (error) => {
      taskManager.failTask(task.id, { message: error.message }, task)
      return `TTS generation failed: ${error.message}`
    },
    onEnd: () => {
      taskManager.finishTask(task.id, task)
      logStreamCompletion(task, res)
      options.onCompleted?.()
    },
    onClose: () => {
      taskManager.cancelTask(task.id, 'Client disconnected', task)
      logger.info(`Streaming ${task.id} cancelled after client disconnect`)
    },
  })
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

/**
 * 拼接音频文件
 */
export async function concatDirAudio({
  fileList,
  outputFile,
  inputDir,
}: ConcatAudioParams): Promise<void> {
  const mp3Files = sortAudioDir(fileList!, '.mp3')
  if (!mp3Files.length) throw new Error('No MP3 files found in input directory')

  const tempListPath = path.resolve(inputDir, 'file_list.txt')
  await fs.writeFile(tempListPath, mp3Files.map((file) => `file '${file}'`).join('\n'))

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(tempListPath)
      .inputFormat('concat')
      .inputOption('-safe', '0')
      .audioCodec('copy')
      .output(outputFile)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`Concat failed: ${err.message}`)))
      .run()
  })
}

/**
 * 拼接字幕文件
 */
export async function concatDirSrt({
  fileList,
  outputFile,
  inputDir,
  jsonFiles,
}: ConcatAudioParams): Promise<void> {
  const _jsonFiles =
    jsonFiles ||
    sortAudioDir(
      fileList!.map((file) => `${file}.json`),
      '.json'
    )
  if (!_jsonFiles.length) throw new Error('No JSON files found for subtitles')

  const subtitleFiles: SubtitleFiles = await Promise.all(
    _jsonFiles.map((file) => readJson<SubtitleFile>(file))
  )
  const mergedJson = mergeSubtitleFiles(subtitleFiles)
  const tempJsonPath = path.resolve(inputDir, 'all_splits.mp3.json')
  await fs.writeFile(tempJsonPath, JSON.stringify(mergedJson, null, 2))
  await generateSrt(tempJsonPath, outputFile.replace('.mp3', '.srt'))
}

/**
 * 按文件名排序音频文件
 */
function sortAudioDir(fileList: string[], ext: string = '.mp3'): string[] {
  return fileList
    .filter((file) => path.extname(file).toLowerCase() === ext)
    .sort(
      (a, b) => Number(path.parse(a).name.split('_')[0]) - Number(path.parse(b).name.split('_')[0])
    )
}

export interface ConcatAudioParams {
  fileList?: string[]
  outputFile: string
  inputDir: string
  jsonFiles?: string[]
}
