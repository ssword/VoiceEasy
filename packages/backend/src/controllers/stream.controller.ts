import path from 'path'
import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'
import taskManager from '../utils/taskManager'
import { generateTTSStream, generateTTSStreamJson } from '../services/tts.stream.service'
import { generateId, streamWithLimit } from '../utils'
import { normalizeTtsRequest } from '../services/ttsRequest'
import {
  createGenerationDiagnostics,
  generationRuntimeMetadata,
  safeErrorMetadata,
  ttsRequestMetadata,
} from '../utils/diagnostics'
/**
 * @description 流式返回音频, 支持长文本
 * @param req
 * @param res
 * @param next
 * @returns ReadableStream
 */
export async function createTaskStream(req: Request, res: Response, next: NextFunction) {
  let task: ReturnType<typeof taskManager.createTask> | undefined
  try {
    if (req.query?.mock) {
      logger.info('Mocking audio stream...')
      streamWithLimit(res, path.join(__dirname, '../../mock/flying.mp3'), 1280) // Mock stream with limit
      return
    }
    const formattedBody = normalizeTtsRequest(req.body)
    task = taskManager.createTask(formattedBody)
    const abortController = new AbortController()
    task.context = {
      req,
      res,
      body: req.body,
      diagnostics: createGenerationDiagnostics(),
      abortSignal: abortController.signal,
    }
    const cancelOnDisconnect = () => {
      if (res.writableFinished || !task) return
      abortController.abort()
      taskManager.cancelTask(task.id, 'Client disconnected', task)
    }
    res.once?.('close', cancelOnDisconnect)
    logger.info('TTS stream request accepted', {
      ...ttsRequestMetadata(req.body, res, task.id),
      interruptionsEnabled: formattedBody.enableInterruptions,
      taskId: task.id,
    })
    try {
      await generateTTSStream(formattedBody, task)
    } finally {
      res.off?.('close', cancelOnDisconnect)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (task) taskManager.failTask(task.id, { message }, task)
    logger.error('TTS stream request failed', {
      ...ttsRequestMetadata(req.body, res, task?.id),
      ...generationRuntimeMetadata(task?.context?.diagnostics),
      error: safeErrorMetadata(error),
    })
    if (task?.context?.abortSignal?.aborted || res.destroyed) return
    if (finishStartedResponse(res)) return
    next(error)
  }
}
export async function generateJson(req: Request, res: Response, next: NextFunction) {
  let task: ReturnType<typeof taskManager.createTask> | undefined
  try {
    const data = req.body?.data
    const formatedBody = data.map((item: any) => normalizeTtsRequest(item))
    const text = data.map((item: any) => item.text).join('')
    const taskParams = {
      ...formatedBody[0],
      text,
    }
    task = taskManager.createTask(taskParams)
    const voice = formatedBody[0].voice

    const segment: Segment = { id: generateId(voice, text), text }
    task.context = {
      req,
      res,
      segment,
      body: req.body,
      diagnostics: createGenerationDiagnostics(formatedBody.length),
    }
    logger.info('TTS JSON stream request accepted', {
      ...ttsRequestMetadata({ ...req.body, text }, res, task.id),
      taskId: task.id,
    })
    await generateTTSStreamJson(formatedBody, task)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (task) taskManager.failTask(task.id, { message }, task)
    logger.error('TTS JSON stream request failed', {
      ...ttsRequestMetadata(req.body, res, task?.id),
      ...generationRuntimeMetadata(task?.context?.diagnostics),
      error: safeErrorMetadata(error),
    })
    if (finishStartedResponse(res)) return
    next(error)
  }
}

function finishStartedResponse(res: Response): boolean {
  if (!res.headersSent) return false
  if (!res.writableEnded) res.end()
  return true
}
