import { ttsPluginManager } from '../pluginManager'
import { EdgeTtsEngine } from './edgeTts'
import { OpenAITtsEngine } from './openaiTts'
import { KokoroTtsEngine } from './kokoroTts'
import { CosyVoiceTtsEngine } from './cosyVoiceTts'
import {
  REGISTER_KOKORO,
  REGISTER_OPENAI_TTS,
  REGISTER_COSYVOICE,
  TTS_KOKORO_URL,
  DASHSCOPE_API_KEY,
  DASHSCOPE_WORKSPACE_ID,
  COSYVOICE_MODEL,
} from '../../config'

export function registerEngines() {
  ttsPluginManager.registerEngine(new EdgeTtsEngine())
  if (REGISTER_OPENAI_TTS) {
    ttsPluginManager.registerEngine(new OpenAITtsEngine(process.env.OPENAI_API_KEY!))
  }
  if (REGISTER_KOKORO) {
    ttsPluginManager.registerEngine(new KokoroTtsEngine(TTS_KOKORO_URL))
  }
  if (REGISTER_COSYVOICE) {
    ttsPluginManager.registerEngine(
      new CosyVoiceTtsEngine({
        apiKey: DASHSCOPE_API_KEY,
        workspaceId: DASHSCOPE_WORKSPACE_ID,
        model: COSYVOICE_MODEL,
      })
    )
  }
}
