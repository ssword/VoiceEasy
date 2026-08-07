import { DEFAULT_ENGINE } from '../config'
import { ttsPluginManager } from '../tts/pluginManager'
import { TTSEngine } from '../tts/types'
import { getPublicVoiceOptions } from '../tts/voiceOptions'

/** Resolve the structured Voice candidates used by every LLM Recommendation flow. */
export async function resolveRecommendationVoices(
  engineName: string,
  detectedVoices: VoiceConfig[],
  engineOverride?: TTSEngine
): Promise<VoiceConfig[]> {
  if (!engineName || engineName === DEFAULT_ENGINE) return detectedVoices

  const engine = engineOverride || ttsPluginManager.getEngine(engineName)
  if (!engine) throw new Error(`TTS engine not found: ${engineName}`)
  return getPublicVoiceOptions(engine)
}
