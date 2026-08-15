import { Request, Response, NextFunction } from 'express'
import { generateTTS } from '../services/tts.service'
import { logger } from '../utils/logger'
import path from 'path'
import fs from 'fs/promises'
import { ALLOWED_EXTENSIONS, AUDIO_DIR, DEFAULT_ENGINE } from '../config'
import taskManager from '../utils/taskManager'
import { ttsPluginManager } from '../tts/pluginManager'
import { getPublicVoiceOptions } from '../tts/voiceOptions'
import { normalizeTtsRequest } from '../services/ttsRequest'
import {
  audioByteLength,
  createGenerationDiagnostics,
  generationRuntimeMetadata,
  safeErrorMetadata,
  ttsRequestMetadata,
} from '../utils/diagnostics'
export async function createTask(req: Request, res: Response, next: NextFunction) {
  const generationDiagnostics = createGenerationDiagnostics()
  try {
    const formattedBody = normalizeTtsRequest(req.body)
    const task = taskManager.createTask(formattedBody)
    const diagnostics = {
      ...ttsRequestMetadata(req.body, res, task.id),
      taskId: task.id,
    }
    logger.info('TTS task accepted', diagnostics)

    generateTTS(formattedBody, task, generationDiagnostics)
      .then((result) => {
        const data = {
          ...result,
          file: path.parse(result.audio).base,
          srt: path.parse(result.srt).base,
        }
        taskManager.updateTask(task.id, { result: data }, task)
        void audioByteLength(AUDIO_DIR, result.audio).then((audioBytes) =>
          logger.info('TTS task completed', {
            ...diagnostics,
            ...generationRuntimeMetadata(generationDiagnostics, { audioBytes }),
          })
        )
      })
      .catch((err) => {
        const data = {
          message: (err as Error).message,
        }
        taskManager.failTask(task.id, data, task)
        logger.error('TTS task failed', {
          ...diagnostics,
          ...generationRuntimeMetadata(generationDiagnostics),
          error: safeErrorMetadata(err),
        })
      })
    const data = {
      success: true,
      data: toPublicTask(task),
      code: 200,
    }
    res.json(data)
  } catch (error) {
    next(error)
  }
}

function toPublicTask(task: ReturnType<typeof taskManager.getTask>) {
  if (!task) return task
  const { updateProgress: _updateProgress, endTask: _endTask, context: _context, ...publicTask } = task
  return publicTask
}
export async function getTask(req: Request, res: Response, next: NextFunction) {
  const taskId = req.params.id
  try {
    const task = taskManager.getTask(taskId)
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found', code: 404 })
      return
    }
    const data = {
      success: true,
      data: toPublicTask(task),
      code: 200,
    }
    res.json(data)
  } catch (error) {
    next(error)
  }
}
export async function getTaskStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const stats = taskManager.getTaskStats()
    logger.debug('stats:', stats)
    if (!stats) {
      res.status(404).json({ success: false, message: 'stats not found', code: 404 })
      return
    }
    const data = {
      success: true,
      data: { ...stats },
      code: 200,
    }
    res.json(data)
  } catch (error) {
    next(error)
  }
}
export async function generateAudio(req: Request, res: Response, next: NextFunction) {
  const generationDiagnostics = createGenerationDiagnostics()
  try {
    const formattedBody = normalizeTtsRequest(req.body)
    const diagnostics = ttsRequestMetadata(req.body, res)
    logger.info('Direct TTS request accepted', {
      ...diagnostics,
      interruptionsEnabled: formattedBody.enableInterruptions,
    })
    let result = await generateTTS(formattedBody, undefined, generationDiagnostics)
    const responseResult = {
      success: true,
      data: {
        ...result,
        file: path.parse(result.audio).base,
        srt: path.parse(result.srt).base,
      },
      code: 200,
    }
    logger.info('Direct TTS request completed', {
      ...diagnostics,
      ...generationRuntimeMetadata(generationDiagnostics, {
        audioBytes: await audioByteLength(AUDIO_DIR, result.audio),
      }),
    })
    if (generationDiagnostics.generationMode === 'timeline-mix') {
      res.setHeader('x-generate-tts-type', 'buffered-timeline')
      res.setHeader('Access-Control-Expose-Headers', 'x-generate-tts-type')
    }
    res.json(responseResult)
  } catch (error) {
    logger.error('Direct TTS request failed', {
      ...ttsRequestMetadata(req.body, res),
      ...generationRuntimeMetadata(generationDiagnostics),
      error: safeErrorMetadata(error),
    })
    next(error)
  }
}

export async function downloadAudio(req: Request, res: Response): Promise<void> {
  const fileName = req.params.file

  try {
    if (!fileName || typeof fileName !== 'string') {
      throw new Error('Invalid file name')
    }

    const fileExt = path.extname(fileName).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(fileExt)) {
      throw new Error('Invalid file type')
    }

    const safeFileName = path.basename(fileName)
    const encodedFileName = encodeURIComponent(safeFileName)
    const filePath = path.join(AUDIO_DIR, safeFileName)

    await fs.access(filePath, fs.constants.R_OK)

    res.setHeader('Content-Type', `audio/${fileExt.slice(1)}`)
    res.setHeader('Content-Disposition', `attachment; filename="${encodedFileName}"`)

    res.download(filePath, safeFileName, (err) => {
      if (err) {
        throw err
      }
      logger.info('Audio download completed', { extension: fileExt })
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('Audio download failed', {
      extension: fileName ? path.extname(fileName).toLowerCase() : '',
      error: safeErrorMetadata(error),
    })

    const statusCode = errorMessage.includes('Invalid')
      ? 400
      : errorMessage.includes('ENOENT')
      ? 404
      : 500

    res.status(statusCode).json({
      error: 'Failed to download file',
      message: errorMessage,
    })
  }
}

export async function getVoiceList(req: Request, res: Response, next: NextFunction) {
  try {
    const engineName = (req.query.engine as string) || DEFAULT_ENGINE
    logger.debug(`Fetching voice list for engine: ${engineName}`)

    const engine = ttsPluginManager.getEngine(engineName)
    if (!engine) {
      res.status(400).json({
        code: 400,
        message: `Unsupported TTS engine: ${engineName}`,
        success: false,
      })
      return
    }

    res.json({
      code: 200,
      data: await getPublicVoiceOptions(engine),
      success: true,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error(`getVoiceList Error: ${errorMessage}`)
    res.status(500).json({
      code: 500,
      message: errorMessage,
      success: false,
    })
  }
}
