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

interface PauseSourceDirective {
  offset: number
  type: 'pause'
  durationMs: number
}

type TimelineControlSourceDirective = InterruptionSourceDirective | PauseSourceDirective
type ParsedTimelineControl = Exclude<TimelineControl, { type: 'serial' }>

export interface TimelineControlSourceContext {
  text: string
  directives: TimelineControlSourceDirective[]
}

/** Kept for callers that have not yet migrated to the Timeline Control name. */
export type InterruptionSourceContext = TimelineControlSourceContext

const DEFAULT_TAG_OVERLAP_MS = 600
const DEFAULT_TAG_DUCK_DB = -8
const DEFAULT_PAUSE_DURATION_MS = 700
const MAX_PAUSE_DURATION_MS = 300000
const timelineControlTagPattern = () => /\[(?:interrupt|pause)(?:\s+[^\]\r\n]*)?\][ \t]*/gi

export class TimelineControlValidationError extends Error {
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'TimelineControlValidationError'
  }
}

export function hasTimelineControlTag(text: unknown): boolean {
  return typeof text === 'string' && timelineControlTagPattern().test(text)
}

/** @deprecated Use hasTimelineControlTag. */
export const hasInterruptionControlTag = hasTimelineControlTag

export function validateTimelineControlTags(text: unknown): void {
  if (typeof text !== 'string') return
  for (const match of text.matchAll(timelineControlTagPattern())) {
    parseTimelineControlTag(match[0])
  }
}

/** Remove source Timeline Control tags before LLM Recommendation and retain their text positions. */
export function prepareTimelineControlSourceText(text: string): TimelineControlSourceContext {
  const directives: TimelineControlSourceDirective[] = []
  let cleanText = ''
  let cursor = 0

  for (const match of text.matchAll(timelineControlTagPattern())) {
    const index = match.index ?? 0
    cleanText += text.slice(cursor, index)
    const control = parseTimelineControlTag(match[0])
    directives.push({ offset: cleanText.length, ...control })
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
    const tags = extractTimelineControlTags(segment.text)
    const directives = sourceDirectives.get(index) || []
    const canonicalControl = parseCanonicalTimelineControl(segment.timelineControl)
    const legacyControl = parseLegacyTimelineControl(segment)

    validateTimelineControlSources({
      index,
      tags,
      sourceDirectives: directives,
      canonicalControl,
      legacyControl,
    })

    const normalizedSegment = tags.text === segment.text ? segment : { ...segment, text: tags.text }
    const sourceDirective = directives[0]
    const requestedControl =
      sourceDirective ?? tags.controls[0] ?? canonicalControl ?? legacyControl
    if (index === 0 || !requestedControl || !enableTimelineControls) {
      return toNormalizedSegment(normalizedSegment, { type: 'serial' })
    }

    if (requestedControl.type === 'pause') {
      if (sourceDirective?.type !== 'pause') {
        return toNormalizedSegment(normalizedSegment, { type: 'serial' })
      }
      return toNormalizedSegment(
        normalizedSegment,
        requestedControl.durationMs > 0
          ? { type: 'pause', durationMs: requestedControl.durationMs }
          : { type: 'serial' }
      )
    }
    const interruptionRequested =
      requestedControl.type === 'interruption'
    const overlapMs = interruptionRequested
      ? clampFiniteNumber(requestedControl.overlapMs, 0, 1000)
      : 0

    if (!interruptionRequested || overlapMs === 0) {
      return toNormalizedSegment(normalizedSegment, { type: 'serial' })
    }

    const duckPreviousDb = clampFiniteNumber(
      requestedControl.duckPreviousDb,
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
  if (timelineControl.type === 'pause') {
    return {
      ...segment,
      timelineControl,
      interrupt: false,
      overlapMs: 0,
      duckPreviousDb: 0,
    }
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
  tags,
  sourceDirectives,
  canonicalControl,
  legacyControl,
}: {
  index: number
  tags: { controls: TimelineControl[] }
  sourceDirectives: TimelineControlSourceDirective[]
  canonicalControl: TimelineControl | undefined
  legacyControl: TimelineControl | undefined
}): void {
  const controlTypes = [
    ...tags.controls.map((control) => control.type),
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
    'Timeline Control validation failed: duplicate Timeline Control directives on ' +
      `Segment ${index + 1}`
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
  if (value.type === 'pause') {
    return { type: 'pause', durationMs: parsePauseDuration(value.durationMs) }
  }
  throw new TimelineControlValidationError('Timeline Control validation failed: invalid canonical control')
}

function parseLegacyTimelineControl(segment: Record<string, unknown>): TimelineControl | undefined {
  if (!Object.prototype.hasOwnProperty.call(segment, 'interrupt')) return undefined
  return segment.interrupt === true
    ? {
        type: 'interruption',
        overlapMs: clampFiniteNumber(segment.overlapMs, 0, 1000),
        duckPreviousDb: clampFiniteNumber(segment.duckPreviousDb, -18, 0),
      }
    : { type: 'serial' }
}

function extractTimelineControlTags(value: unknown): {
  text: unknown
  controls: TimelineControl[]
} {
  if (typeof value !== 'string') return { text: value, controls: [] }

  const controls: TimelineControl[] = []
  const text = value.replace(timelineControlTagPattern(), (tag) => {
    controls.push(parseTimelineControlTag(tag))
    return ''
  })

  return { text, controls }
}

function parseTimelineControlTag(tag: string): ParsedTimelineControl {
  if (/^\[pause(?:\s|\])/i.test(tag)) {
    const attributes = tag.slice(1, -1).replace(/^pause/i, '').trim()
    if (!attributes) return { type: 'pause', durationMs: DEFAULT_PAUSE_DURATION_MS }
    const durationMatch = attributes.match(
      /^duration\s*=\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:ms)?$/i
    )
    if (!durationMatch) {
      throw new TimelineControlValidationError(
        'Pause duration must be a finite number from 0 through 300000 ms'
      )
    }
    return { type: 'pause', durationMs: parsePauseDuration(Number(durationMatch[1])) }
  }
  const attributes = parseInterruptionTag(tag)
  return {
    type: 'interruption',
    overlapMs: attributes.overlapMs ?? DEFAULT_TAG_OVERLAP_MS,
    duckPreviousDb: attributes.duckPreviousDb ?? DEFAULT_TAG_DUCK_DB,
  }
}

function parsePauseDuration(value: unknown): number {
  const durationMs = Number(value)
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_PAUSE_DURATION_MS) {
    throw new TimelineControlValidationError(
      'Pause duration must be a finite number from 0 through 300000 ms'
    )
  }
  return durationMs
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
): Map<number, TimelineControlSourceDirective[]> {
  const mapped = new Map<number, TimelineControlSourceDirective[]>()
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
