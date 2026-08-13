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

/** Keep untrusted LLM output inside the selected Engine Plugin's Voice List. */
export function enforceRecommendationVoices<T extends Record<string, unknown>>(
  segments: T[],
  selectedVoices: VoiceConfig[]
): T[] {
  const fallbackVoice = selectedVoices[0]?.Name
  if (!fallbackVoice) throw new Error('The selected TTS Engine has no Voices.')
  const allowedVoices = new Set(selectedVoices.map((voice) => voice.Name))

  return segments.map((segment) => ({
    ...segment,
    name:
      typeof segment.name === 'string' && allowedVoices.has(segment.name)
        ? segment.name
        : fallbackVoice,
  }))
}
