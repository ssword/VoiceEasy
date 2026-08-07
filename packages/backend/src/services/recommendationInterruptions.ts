import { clampFiniteNumber } from '../utils/safeNumber'

export interface RecommendationInterruption {
  interrupt: boolean
  overlapMs: number
  duckPreviousDb: number
}

export type NormalizedRecommendationSegment = Record<string, unknown> &
  RecommendationInterruption

/**
 * Converts untrusted LLM Recommendation metadata into bounded Audio Assembly
 * values. Invalid or disabled overlap always becomes a serial Segment.
 */
export function normalizeRecommendationSegments(
  segments: unknown[],
  enableInterruptions: boolean
): NormalizedRecommendationSegment[] {
  return segments.map((value, index) => {
    const segment = isRecord(value) ? value : {}
    const interrupt = enableInterruptions && index > 0 && segment.interrupt === true
    const overlapMs = interrupt ? clampFiniteNumber(segment.overlapMs, 0, 1000) : 0

    if (!interrupt || overlapMs === 0) {
      return { ...segment, interrupt: false, overlapMs: 0, duckPreviousDb: 0 }
    }

    return {
      ...segment,
      interrupt: true,
      overlapMs,
      duckPreviousDb: clampFiniteNumber(segment.duckPreviousDb, -18, 0),
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
