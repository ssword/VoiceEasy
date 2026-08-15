import { clampFiniteNumber } from '../utils/safeNumber'

export interface RecommendationInterruption {
  interrupt: boolean
  overlapMs: number
  duckPreviousDb: number
}

export type NormalizedRecommendationSegment = Record<string, unknown> &
  RecommendationInterruption & {
    timelineControl: TimelineControl
  }

interface InterruptionSourceDirective {
  offset: number
  type: 'interruption'
  overlapMs: number
  duckPreviousDb: number
}

export interface TimelineControlSourceContext {
  text: string
  directives: InterruptionSourceDirective[]
}

/** Kept for callers that have not yet migrated to the Timeline Control name. */
export type InterruptionSourceContext = TimelineControlSourceContext

const DEFAULT_TAG_OVERLAP_MS = 600
const DEFAULT_TAG_DUCK_DB = -8
const interruptionTagPattern = () => /\[interrupt(?:\s+[^\]\r\n]*)?\][ \t]*/gi

export class TimelineControlValidationError extends Error {
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'TimelineControlValidationError'
  }
}

export function hasTimelineControlTag(text: unknown): boolean {
  return typeof text === 'string' && interruptionTagPattern().test(text)
}

/** @deprecated Use hasTimelineControlTag. */
export const hasInterruptionControlTag = hasTimelineControlTag

/** Remove source Timeline Control tags before LLM Recommendation and retain their text positions. */
export function prepareTimelineControlSourceText(text: string): TimelineControlSourceContext {
  const directives: InterruptionSourceDirective[] = []
  let cleanText = ''
  let cursor = 0

  for (const match of text.matchAll(interruptionTagPattern())) {
    const index = match.index ?? 0
    cleanText += text.slice(cursor, index)
    const attributes = parseInterruptionTag(match[0])
    directives.push({
      offset: cleanText.length,
      type: 'interruption',
      overlapMs: attributes.overlapMs ?? DEFAULT_TAG_OVERLAP_MS,
      duckPreviousDb: attributes.duckPreviousDb ?? DEFAULT_TAG_DUCK_DB,
    })
    cursor = index + match[0].length
  }
  cleanText += text.slice(cursor)

  return { text: cleanText, directives }
}

/** @deprecated Use prepareTimelineControlSourceText. */
export const prepareInterruptionSourceText = prepareTimelineControlSourceText

/**
 * Resolves all Timeline Control sources into one relation per Segment before
 * Audio Assembly. Legacy Interruption fields remain as a compatibility view.
 */
export function normalizeTimelineControlSegments(
  segments: unknown[],
  enableTimelineControls: boolean,
  source?: TimelineControlSourceContext
): NormalizedRecommendationSegment[] {
  const sourceDirectives = mapSourceDirectivesToSegments(segments, source)

  return segments.map((value, index) => {
    const segment = isRecord(value) ? value : {}
    const tag = extractInterruptionTag(segment.text)
    const directives = sourceDirectives.get(index) || []
    const canonicalControl = parseCanonicalTimelineControl(segment.timelineControl)
    const legacyControl = parseLegacyTimelineControl(segment)

    validateTimelineControlSources({
      index,
      tagCount: tag.count,
      sourceDirectives: directives,
      canonicalControl,
      legacyControl,
    })

    const normalizedSegment = tag.text === segment.text ? segment : { ...segment, text: tag.text }
    const sourceDirective = directives[0]
    const interruptionRequested =
      enableTimelineControls &&
      index > 0 &&
      (sourceDirective !== undefined ||
        tag.count > 0 ||
        legacyControl?.type === 'interruption' ||
        canonicalControl?.type === 'interruption')
    const overlapMs = interruptionRequested
      ? clampFiniteNumber(
          sourceDirective?.overlapMs ??
            (tag.count > 0
              ? (tag.overlapMs ?? DEFAULT_TAG_OVERLAP_MS)
              : canonicalControl?.type === 'interruption'
                ? canonicalControl.overlapMs
                : segment.overlapMs),
          0,
          1000
        )
      : 0

    if (!interruptionRequested || overlapMs === 0) {
      return toNormalizedSegment(normalizedSegment, { type: 'serial' })
    }

    const duckPreviousDb = clampFiniteNumber(
      sourceDirective?.duckPreviousDb ??
        (tag.count > 0
          ? (tag.duckPreviousDb ?? DEFAULT_TAG_DUCK_DB)
          : canonicalControl?.type === 'interruption'
            ? canonicalControl.duckPreviousDb
            : segment.duckPreviousDb),
      -18,
      0
    )
    return toNormalizedSegment(normalizedSegment, {
      type: 'interruption',
      overlapMs,
      duckPreviousDb,
    })
  })
}

/** @deprecated Use normalizeTimelineControlSegments. */
export const normalizeRecommendationSegments = normalizeTimelineControlSegments

function toNormalizedSegment(
  segment: Record<string, unknown>,
  timelineControl: TimelineControl
): NormalizedRecommendationSegment {
  if (timelineControl.type === 'serial') {
    return { ...segment, timelineControl, interrupt: false, overlapMs: 0, duckPreviousDb: 0 }
  }
  return {
    ...segment,
    timelineControl,
    interrupt: true,
    overlapMs: timelineControl.overlapMs,
    duckPreviousDb: timelineControl.duckPreviousDb,
  }
}

function validateTimelineControlSources({
  index,
  tagCount,
  sourceDirectives,
  canonicalControl,
  legacyControl,
}: {
  index: number
  tagCount: number
  sourceDirectives: InterruptionSourceDirective[]
  canonicalControl: TimelineControl | undefined
  legacyControl: TimelineControl | undefined
}): void {
  const controlTypes = [
    ...Array(tagCount).fill('interruption'),
    ...sourceDirectives.map((directive) => directive.type),
    ...(canonicalControl ? [canonicalControl.type] : []),
    ...(legacyControl ? [legacyControl.type] : []),
  ]
  if (controlTypes.length < 2) return

  if (new Set(controlTypes).size > 1) {
    throw new TimelineControlValidationError(
      `Timeline Control validation failed: conflicting controls on Segment ${index + 1}`
    )
  }

  throw new TimelineControlValidationError(
    `Timeline Control validation failed: duplicate Interruption directives on Segment ${index + 1}`
  )
}

function parseCanonicalTimelineControl(value: unknown): TimelineControl | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new TimelineControlValidationError('Timeline Control validation failed: invalid canonical control')
  }
  if (value.type === 'serial') return { type: 'serial' }
  if (value.type === 'interruption') {
    return {
      type: 'interruption',
      overlapMs: clampFiniteNumber(value.overlapMs, 0, 1000),
      duckPreviousDb: clampFiniteNumber(value.duckPreviousDb, -18, 0),
    }
  }
  throw new TimelineControlValidationError('Timeline Control validation failed: invalid canonical control')
}

function parseLegacyTimelineControl(segment: Record<string, unknown>): TimelineControl | undefined {
  if (!Object.prototype.hasOwnProperty.call(segment, 'interrupt')) return undefined
  return segment.interrupt === true ? { type: 'interruption', overlapMs: 0, duckPreviousDb: 0 } : { type: 'serial' }
}

function extractInterruptionTag(value: unknown): {
  text: unknown
  count: number
  overlapMs?: number
  duckPreviousDb?: number
} {
  if (typeof value !== 'string') return { text: value, count: 0 }

  let count = 0
  let overlapMs: number | undefined
  let duckPreviousDb: number | undefined
  const text = value.replace(interruptionTagPattern(), (tag) => {
    count++
    const attributes = parseInterruptionTag(tag)
    if (attributes.overlapMs !== undefined) overlapMs = attributes.overlapMs
    if (attributes.duckPreviousDb !== undefined) duckPreviousDb = attributes.duckPreviousDb
    return ''
  })

  return { text, count, overlapMs, duckPreviousDb }
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
  source?: TimelineControlSourceContext
): Map<number, InterruptionSourceDirective[]> {
  const mapped = new Map<number, InterruptionSourceDirective[]>()
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
      if (anchor) segmentIndex = comparableSegments.findIndex((text) => text.includes(anchor))
    }

    if (segmentIndex >= 0) {
      const existing = mapped.get(segmentIndex) || []
      existing.push(directive)
      mapped.set(segmentIndex, existing)
    }
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
