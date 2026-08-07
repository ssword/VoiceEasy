import { DEFAULT_ENGINE } from '../config'
import { TTSEngine } from './types'

export interface PublicVoice {
  Name: string
  cnName?: string
  Gender: string
  ContentCategories: string[]
  VoicePersonalities: string[]
  language?: string
  age?: string
}

const EDGE_VOICES = require('../llm/prompt/voice.json') as PublicVoice[]

/** Resolve every Engine Plugin's Voice data to the public structured API contract. */
export async function getPublicVoiceOptions(engine: TTSEngine): Promise<PublicVoice[]> {
  if (engine.name === DEFAULT_ENGINE) return EDGE_VOICES
  const voices = engine.getVoiceOptions ? await engine.getVoiceOptions() : []
  return voices.map((voice) =>
    typeof voice === 'string'
      ? {
          Name: voice,
          Gender: 'All',
          ContentCategories: [],
          VoicePersonalities: [],
        }
      : (voice as unknown as PublicVoice)
  )
}
