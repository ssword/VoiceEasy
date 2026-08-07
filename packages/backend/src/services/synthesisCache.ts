import crypto from 'crypto'
import { DEFAULT_ENGINE } from '../config'
import { ttsPluginManager } from '../tts/pluginManager'

export interface SynthesisCacheIdentity {
  engine: string
  cacheNamespace: string
  text: string
  voice: string
  rate: string
  pitch: string
  volume: string
  instruction: string
  outputFormat: string
  sampleRate: number | null
  useLLM: boolean
  recommendationModel: string
}

export type SynthesisCacheInput = Pick<TTSParams, 'text' | 'voice'> &
  Partial<Pick<TTSParams, 'rate' | 'pitch' | 'volume' | 'engine' | 'instruction'>> & {
    cacheNamespace?: string
    outputFormat?: string
    sampleRate?: number | null
    useLLM?: boolean
    recommendationModel?: string
  }

export function createSynthesisCacheIdentity(
  input: SynthesisCacheInput
): SynthesisCacheIdentity {
  const engineName = input.engine || DEFAULT_ENGINE
  const engine = ttsPluginManager.getEngine(engineName)
  return {
    engine: engineName,
    cacheNamespace: input.cacheNamespace || engine?.cacheNamespace || engineName,
    text: input.text,
    voice: input.voice,
    rate: input.rate || '',
    pitch: input.pitch || '',
    volume: input.volume || '',
    instruction: input.instruction || '',
    outputFormat: input.outputFormat || engine?.outputFormat || 'mp3',
    sampleRate: input.sampleRate ?? engine?.sampleRate ?? null,
    useLLM: input.useLLM ?? false,
    recommendationModel: input.recommendationModel || '',
  }
}

export function createSynthesisCacheKey(input: SynthesisCacheInput): string {
  const identity = createSynthesisCacheIdentity(input)
  const canonical = JSON.stringify(identity)
  return crypto.createHash('sha256').update(canonical).digest('hex')
}
