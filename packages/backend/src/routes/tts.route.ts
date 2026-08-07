import { Router } from 'express'
import {
  generateAudio,
  downloadAudio,
  getVoiceList,
  createTask,
  getTask,
  getTaskStats,
} from '../controllers/tts.controller'
import { pickSchema } from '../controllers/pick.controller'
import { ttsPluginManager } from '../tts/pluginManager'
import { createTaskStream, generateJson } from '../controllers/stream.controller'
import { validateJson } from '../schema/generate'
import { getPublicVoiceOptions } from '../tts/voiceOptions'

const router = Router()

router.get('/engines', async (req, res, next) => {
  try {
    const allEngines = ttsPluginManager.getAllEngines()
    const engines = await Promise.all(
      allEngines.map(async (engine) => ({
        name: engine.name,
        languages: await engine.getSupportedLanguages(),
        voices: await getPublicVoiceOptions(engine),
        supportsSubtitles: engine.supportsSubtitles !== false,
      }))
    )
    res.json({ code: 200, data: engines, success: true })
  } catch (err) {
    next(err)
  }
})

router.get('/voiceList', getVoiceList)
router.get('/task/stats', getTaskStats)
router.get('/task/:id', getTask)
router.get('/download/:file', downloadAudio)

router.post('/create', pickSchema, createTask)
router.post('/createStream', pickSchema, createTaskStream)
router.post('/generate', pickSchema, generateAudio)
router.post('/generateJson', validateJson, generateJson)

export default router
