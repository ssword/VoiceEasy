import path from 'path'
import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'
import taskManager from '../utils/taskManager'
import { generateTTSStream, generateTTSStreamJson } from '../services/tts.stream.service'
import { generateId, streamWithLimit } from '../utils'
import { normalizeTtsRequest } from '../services/ttsRequest'
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
    logger.debug('Generating audio with body:', req.body)
    const formattedBody = normalizeTtsRequest(req.body)
    task = taskManager.createTask(formattedBody)
    task.context = { req, res, body: req.body }
    logger.info(`Generated stream task ID: ${task.id}`)
    await generateTTSStream(formattedBody, task)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (task) taskManager.failTask(task.id, { message }, task)
    logger.error(`createTaskStream error: ${message}`)
    if (finishStartedResponse(res)) return
    next(error)
  }
}
export async function generateJson(req: Request, res: Response, next: NextFunction) {
  let task: ReturnType<typeof taskManager.createTask> | undefined
  try {
    const data = req.body?.data
    logger.debug('generateJson with body:', data)
    const formatedBody = data.map((item: any) => normalizeTtsRequest(item))
    const text = data.map((item: any) => item.text).join('')
    const taskParams = {
      ...formatedBody[0],
      text,
    }
    task = taskManager.createTask(taskParams)
    const voice = formatedBody[0].voice

    const segment: Segment = { id: generateId(voice, text), text }
    task.context = { req, res, segment, body: req.body }
    logger.info(`Generated stream task ID: ${task.id}`)
    await generateTTSStreamJson(formatedBody, task)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (task) taskManager.failTask(task.id, { message }, task)
    logger.error(`generateJson error: ${message}`)
    if (finishStartedResponse(res)) return
    next(error)
  }
}

function finishStartedResponse(res: Response): boolean {
  if (!res.headersSent) return false
  if (!res.writableEnded) res.end()
  return true
}
