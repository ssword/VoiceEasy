import crypto from 'crypto'
import { DEFAULT_ENGINE } from '../config'
import { ttsPluginManager } from '../tts/pluginManager'
import { clampFiniteNumber } from '../utils/safeNumber'

export const FINAL_AUDIO_CACHE_VERSION = 3
export const TIMELINE_MIX_ALGORITHM_VERSION = 'timeline-mix-v4-manual-pause'

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
  enableInterruptions: boolean
}

export type SynthesisCacheInput = Pick<TTSParams, 'text' | 'voice'> &
  Partial<Pick<TTSParams, 'rate' | 'pitch' | 'volume' | 'engine' | 'instruction'>> & {
    cacheNamespace?: string
    outputFormat?: string
    sampleRate?: number | null
    useLLM?: boolean
    recommendationModel?: string
    enableInterruptions?: boolean
    interrupt?: boolean
    overlapMs?: number
    duckPreviousDb?: number
    timelineControl?: TimelineControl
  }

export interface FinalAudioCacheInput {
  enableInterruptions: boolean
  segments: SynthesisCacheInput[]
  sourceText?: string
  recommendationModel?: string
}

export interface FinalAudioCacheIdentity {
  cacheVersion: number
  enableInterruptions: boolean
  mode: 'concat' | 'timeline-mix'
  timelineMixAlgorithmVersion: string
  sourceKey: string
  recommendationModel: string
  timeline: Array<{
    synthesisKey: string
    type: TimelineControl['type']
    interrupt: boolean
    overlapMs: number
    duckPreviousDb: number
    pauseDurationMs: number
  }>
}

export interface FinalAudioCacheDescriptor {
  identity: FinalAudioCacheIdentity
  key: string
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
    enableInterruptions: input.enableInterruptions ?? false,
  }
}

export function createSynthesisCacheKey(input: SynthesisCacheInput): string {
  const identity = createSynthesisCacheIdentity(input)
  const canonical = JSON.stringify(identity)
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

export function createFinalAudioCacheIdentity(
  input: FinalAudioCacheInput
): FinalAudioCacheIdentity {
  const timeline = input.segments.map((segment, index) => {
    const control = normalizedTimelineControl(segment, index, input.enableInterruptions)
    const interrupt = control.type === 'interruption'
    return {
      synthesisKey: createSynthesisCacheKey(segment),
      type: control.type,
      interrupt,
      overlapMs: interrupt ? control.overlapMs : 0,
      duckPreviousDb: interrupt ? control.duckPreviousDb : 0,
      pauseDurationMs: control.type === 'pause' ? control.durationMs : 0,
    }
  })
  return {
    cacheVersion: FINAL_AUDIO_CACHE_VERSION,
    enableInterruptions: input.enableInterruptions,
    mode: timeline.some((segment) => segment.type !== 'serial') ? 'timeline-mix' : 'concat',
    timelineMixAlgorithmVersion: TIMELINE_MIX_ALGORITHM_VERSION,
    sourceKey: crypto
      .createHash('sha256')
      .update(input.sourceText || '')
      .digest('hex'),
    recommendationModel: input.recommendationModel || '',
    timeline,
  }
}

function normalizedTimelineControl(
  segment: SynthesisCacheInput,
  index: number,
  enabled: boolean
): TimelineControl {
  if (!enabled || index === 0) return { type: 'serial' }
  if (segment.timelineControl?.type === 'pause') {
    const durationMs = clampFiniteNumber(segment.timelineControl.durationMs, 0, 300000)
    return durationMs > 0 ? { type: 'pause', durationMs } : { type: 'serial' }
  }
  if (segment.timelineControl?.type === 'interruption') {
    const overlapMs = clampFiniteNumber(segment.timelineControl.overlapMs, 0, 1000)
    return overlapMs > 0
      ? {
          type: 'interruption',
          overlapMs,
          duckPreviousDb: clampFiniteNumber(segment.timelineControl.duckPreviousDb, -18, 0),
        }
      : { type: 'serial' }
  }
  const overlapMs = segment.interrupt === true ? clampFiniteNumber(segment.overlapMs, 0, 1000) : 0
  return overlapMs > 0
    ? {
        type: 'interruption',
        overlapMs,
        duckPreviousDb: clampFiniteNumber(segment.duckPreviousDb, -18, 0),
      }
    : { type: 'serial' }
}

export function createFinalAudioCacheKey(input: FinalAudioCacheInput): string {
  return createFinalAudioCacheDescriptor(input).key
}

export function createFinalAudioCacheDescriptor(
  input: FinalAudioCacheInput
): FinalAudioCacheDescriptor {
  const identity = createFinalAudioCacheIdentity(input)
  return {
    identity,
    key: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  }
}
