import { clampFiniteNumber } from '../utils/safeNumber'

export interface RecommendationInterruption {
  interrupt: boolean
  overlapMs: number
  duckPreviousDb: number
}

export type NormalizedRecommendationSegment = Record<string, unknown> &
  RecommendationInterruption

export interface InterruptionSourceContext {
  text: string
  directives: Array<{
    offset: number
    overlapMs: number
    duckPreviousDb: number
  }>
}

const DEFAULT_TAG_OVERLAP_MS = 600
const DEFAULT_TAG_DUCK_DB = -8
const interruptionTagPattern = () => /\[interrupt(?:\s+[^\]\r\n]*)?\][ \t]*/gi

export function hasInterruptionControlTag(text: unknown): boolean {
  return typeof text === 'string' && interruptionTagPattern().test(text)
}

/** Remove source control tags before LLM Recommendation and retain their text positions. */
export function prepareInterruptionSourceText(text: string): InterruptionSourceContext {
  const directives: InterruptionSourceContext['directives'] = []
  let cleanText = ''
  let cursor = 0

  for (const match of text.matchAll(interruptionTagPattern())) {
    const index = match.index ?? 0
    cleanText += text.slice(cursor, index)
    const attributes = parseInterruptionTag(match[0])
    directives.push({
      offset: cleanText.length,
      overlapMs: attributes.overlapMs ?? DEFAULT_TAG_OVERLAP_MS,
      duckPreviousDb: attributes.duckPreviousDb ?? DEFAULT_TAG_DUCK_DB,
    })
    cursor = index + match[0].length
  }
  cleanText += text.slice(cursor)

  return { text: cleanText, directives }
}

/**
 * Converts untrusted LLM Recommendation metadata into bounded Audio Assembly
 * values. Invalid or disabled overlap always becomes a serial Segment.
 */
export function normalizeRecommendationSegments(
  segments: unknown[],
  enableInterruptions: boolean,
  source?: InterruptionSourceContext
): NormalizedRecommendationSegment[] {
  const sourceDirectives = mapSourceDirectivesToSegments(segments, source)
  return segments.map((value, index) => {
    const segment = isRecord(value) ? value : {}
    const tag = extractInterruptionTag(segment.text)
    const sourceDirective = sourceDirectives.get(index)
    const normalizedSegment = tag.text === segment.text ? segment : { ...segment, text: tag.text }
    const interrupt =
      enableInterruptions &&
      index > 0 &&
      (sourceDirective !== undefined || tag.found || segment.interrupt === true)
    const overlapMs = interrupt
      ? clampFiniteNumber(
          sourceDirective?.overlapMs ??
            (tag.found ? (tag.overlapMs ?? DEFAULT_TAG_OVERLAP_MS) : segment.overlapMs),
          0,
          1000
        )
      : 0

    if (!interrupt || overlapMs === 0) {
      return { ...normalizedSegment, interrupt: false, overlapMs: 0, duckPreviousDb: 0 }
    }

    return {
      ...normalizedSegment,
      interrupt: true,
      overlapMs,
      duckPreviousDb: clampFiniteNumber(
        sourceDirective?.duckPreviousDb ??
          (tag.found
            ? (tag.duckPreviousDb ?? DEFAULT_TAG_DUCK_DB)
            : segment.duckPreviousDb),
        -18,
        0
      ),
    }
  })
}

function extractInterruptionTag(value: unknown): {
  text: unknown
  found: boolean
  overlapMs?: number
  duckPreviousDb?: number
} {
  if (typeof value !== 'string') return { text: value, found: false }

  let found = false
  let overlapMs: number | undefined
  let duckPreviousDb: number | undefined
  const text = value.replace(interruptionTagPattern(), (tag) => {
    found = true
    const attributes = parseInterruptionTag(tag)
    if (attributes.overlapMs !== undefined) overlapMs = attributes.overlapMs
    if (attributes.duckPreviousDb !== undefined) duckPreviousDb = attributes.duckPreviousDb
    return ''
  })

  return { text, found, overlapMs, duckPreviousDb }
}

function parseInterruptionTag(tag: string): {
  overlapMs?: number
  duckPreviousDb?: number
} {
  const overlapMatch = tag.match(
    /\boverlap\s*=\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:ms)?\b/i
  )
  const duckMatch = tag.match(
    /\bduck\s*=\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:db)?\b/i
  )
  return {
    overlapMs: overlapMatch ? Number(overlapMatch[1]) : undefined,
    duckPreviousDb: duckMatch ? Number(duckMatch[1]) : undefined,
  }
}

function mapSourceDirectivesToSegments(
  segments: unknown[],
  source?: InterruptionSourceContext
): Map<number, InterruptionSourceContext['directives'][number]> {
  const mapped = new Map<number, InterruptionSourceContext['directives'][number]>()
  if (!source?.directives.length) return mapped

  const comparableSegments = segments.map((value) =>
    comparableText(isRecord(value) ? value.text : '')
  )
  const comparableSource = comparableText(source.text)
  const combinedSegments = comparableSegments.join('')

  for (const directive of source.directives) {
    const sourceOffset = comparableText(source.text.slice(0, directive.offset)).length
    let segmentIndex = -1

    if (combinedSegments === comparableSource) {
      let segmentStart = 0
      segmentIndex = comparableSegments.findIndex((text) => {
        const containsOffset = sourceOffset >= segmentStart && sourceOffset < segmentStart + text.length
        segmentStart += text.length
        return containsOffset
      })
    }

    if (segmentIndex < 0) {
      const anchor = comparableText(source.text.slice(directive.offset)).slice(0, 12)
      if (anchor) {
        segmentIndex = comparableSegments.findIndex((text) => text.includes(anchor))
      }
    }

    if (segmentIndex >= 0) mapped.set(segmentIndex, directive)
  }

  return mapped
}

function comparableText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\[[^\]\r\n]{1,80}\]/g, '').replace(/\s+/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
