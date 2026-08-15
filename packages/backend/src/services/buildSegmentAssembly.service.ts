import fs from 'fs/promises'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { PassThrough, Readable } from 'stream'
import { spawn } from 'child_process'
import { generateSrt } from './edge-tts.service'
import { readJson } from '../utils'
import {
  mergeSubtitleFiles as concatSubtitleFiles,
  placeSubtitleFilesOnTimeline,
  SubtitleFile,
  SubtitleFiles,
} from '../utils/subtitle'
import { clampFiniteNumber } from '../utils/safeNumber'

const EDGE_SILENCE_THRESHOLD_DB = -45
const MIN_EDGE_SILENCE_SECONDS = 0.08
const EDGE_SILENCE_PADDING_SECONDS = 0.02
const REACTION_DELAY_SECONDS = 0.1
const DUCK_RAMP_SECONDS = 0.22
const INTERRUPTED_TAIL_FADE_SECONDS = 0.35
const NEW_SPEAKER_FADE_IN_SECONDS = 0.02

export interface GeneratedFileBuildSegmentAudio {
  audioFile: string
}

export interface TimelineBuildSegmentAudio extends GeneratedFileBuildSegmentAudio {
  interrupt: boolean
  overlapMs: number
  duckPreviousDb: number
}

export interface GeneratedStreamBuildSegmentAudio {
  audioStream: Readable
}

export type BuildSegmentAssemblyRequest =
  | {
      strategy: 'concat'
      segments: Iterable<GeneratedFileBuildSegmentAudio>
      inputDir: string
      outputFile: string
    }
  | {
      strategy: 'timeline-mix'
      segments: Iterable<TimelineBuildSegmentAudio>
      inputRoot: string
      outputFile: string
      signal?: AbortSignal
    }
  | {
      strategy: 'stream'
      segments:
        | Iterable<GeneratedStreamBuildSegmentAudio>
        | AsyncIterable<GeneratedStreamBuildSegmentAudio>
      output: PassThrough
    }

export interface TimelineBuildSegmentAssemblyResult {
  segmentStartsMs: number[]
  segmentTrimStartsMs: number[]
  segmentDurationsMs: number[]
  mixDurationMs: number
}

interface SegmentAudioBounds {
  trimStartMs: number
  trimEndMs: number
  durationMs: number
}

/**
 * Assembles already-generated Build Segment audio in caller-supplied order.
 *
 * Engine Plugins remain responsible for synthesizing one Build Segment. This
 * boundary owns how those ordered results become the final file or response
 * stream, so future assembly strategies have one integration point.
 */
export function assembleBuildSegmentAudio(
  request: Extract<BuildSegmentAssemblyRequest, { strategy: 'timeline-mix' }>
): Promise<TimelineBuildSegmentAssemblyResult>
export function assembleBuildSegmentAudio(
  request: Exclude<BuildSegmentAssemblyRequest, { strategy: 'timeline-mix' }>
): Promise<void>
export async function assembleBuildSegmentAudio(
  request: BuildSegmentAssemblyRequest
): Promise<void | TimelineBuildSegmentAssemblyResult> {
  if (request.strategy === 'stream') {
    let activeSegment: Readable | undefined
    const stopActiveSegment = () => activeSegment?.destroy()
    request.output.once('close', stopActiveSegment)
    try {
      for await (const segment of request.segments) {
        activeSegment = segment.audioStream
        for await (const chunk of activeSegment) {
          await writeStreamingAudio(request.output, chunk)
        }
        activeSegment = undefined
      }
      request.output.end()
    } finally {
      request.output.off('close', stopActiveSegment)
      activeSegment?.destroy()
    }
    return
  }

  if (request.strategy === 'timeline-mix') {
    return timelineMixAudio(
      Array.from(request.segments),
      request.inputRoot,
      request.outputFile,
      request.signal
    )
  }

  const fileList = Array.from(request.segments, (segment) => segment.audioFile)
  await concatAudioFiles({
    inputDir: request.inputDir,
    outputFile: request.outputFile,
    fileList,
  })
}

async function timelineMixAudio(
  segments: TimelineBuildSegmentAudio[],
  inputRoot: string,
  outputFile: string,
  signal?: AbortSignal
): Promise<TimelineBuildSegmentAssemblyResult> {
  signal?.throwIfAborted()
  if (!segments.length) throw new Error('No Build Segment audio provided for Timeline Mix')
  const resolvedInputRoot = await fs.realpath(inputRoot).catch(() => undefined)
  if (!resolvedInputRoot) throw new Error('Timeline Mix internal root is missing')
  const resolvedOutputParent = await fs.realpath(path.dirname(outputFile)).catch(() => undefined)
  const resolvedOutputFile = resolvedOutputParent
    ? path.join(resolvedOutputParent, path.basename(outputFile))
    : undefined
  if (!resolvedOutputFile || !isPathInside(resolvedInputRoot, resolvedOutputFile)) {
    throw new Error('Timeline Mix output must use an internal path')
  }

  const audioBounds: SegmentAudioBounds[] = []
  const internalAudioFiles: string[] = []
  for (const [index, segment] of segments.entries()) {
    const internalAudioFile = await fs.realpath(segment.audioFile).catch(() => undefined)
    if (!internalAudioFile) throw new Error('Timeline Mix input is missing or empty')
    if (!isPathInside(resolvedInputRoot, internalAudioFile)) {
      throw new Error('Timeline Mix input must use an internal path')
    }
    const stat = await fs.stat(internalAudioFile).catch(() => undefined)
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error('Timeline Mix input is missing or empty')
    }
    internalAudioFiles.push(internalAudioFile)
    const sourceDurationMs = await probeDurationMs(internalAudioFile, signal)
    const trimLeadingSilence = index > 0 && segment.interrupt
    const trimTrailingSilence = segments[index + 1]?.interrupt === true
    audioBounds.push(
      trimLeadingSilence || trimTrailingSilence
        ? await probeSegmentAudioBounds(
            internalAudioFile,
            sourceDurationMs,
            trimLeadingSilence,
            trimTrailingSilence,
            signal
          )
        : { trimStartMs: 0, trimEndMs: sourceDurationMs, durationMs: sourceDurationMs }
    )
  }
  const durationsMs = audioBounds.map((bounds) => bounds.durationMs)

  const startsMs = [0]
  const effectiveOverlapsMs = [0]
  for (let index = 1; index < segments.length; index++) {
    const overlapMs = segments[index].interrupt
      ? clampFiniteNumber(segments[index].overlapMs, 0, 1000)
      : 0
    const effectiveOverlapMs = Math.min(overlapMs, durationsMs[index - 1])
    effectiveOverlapsMs[index] = effectiveOverlapMs
    startsMs[index] = Math.max(
      0,
      Math.round(startsMs[index - 1] + durationsMs[index - 1] - effectiveOverlapMs)
    )
  }

  const filters = segments.map((segment, index) => {
    const bounds = audioBounds[index]
    const filtersForInput = [
      `atrim=start=${formatFfmpegNumber(bounds.trimStartMs / 1000)}:end=${formatFfmpegNumber(
        bounds.trimEndMs / 1000
      )}`,
      'asetpts=PTS-STARTPTS',
      'aresample=44100',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
    ]
    if (index > 0 && segment.interrupt) {
      filtersForInput.push(
        `afade=t=in:st=0:d=${formatFfmpegNumber(NEW_SPEAKER_FADE_IN_SECONDS)}`
      )
    }
    const nextSegment = segments[index + 1]
    const nextOverlapMs = effectiveOverlapsMs[index + 1] || 0
    if (nextSegment?.interrupt && nextOverlapMs > 0) {
      const duckDb = clampFiniteNumber(nextSegment.duckPreviousDb, -18, 0)
      const durationSeconds = durationsMs[index] / 1000
      const interruptionStartSeconds = Math.max(0, durationSeconds - nextOverlapMs / 1000)
      const reactionEndSeconds = Math.min(
        durationSeconds,
        interruptionStartSeconds + REACTION_DELAY_SECONDS
      )
      const rampEndSeconds = Math.min(
        durationSeconds,
        reactionEndSeconds + DUCK_RAMP_SECONDS
      )
      const rampDurationSeconds = rampEndSeconds - reactionEndSeconds
      if (rampDurationSeconds > 0) {
        const reactionEnd = formatFfmpegNumber(reactionEndSeconds)
        const rampDuration = formatFfmpegNumber(rampDurationSeconds)
        const progress = `min(max((t-${reactionEnd})/${rampDuration},0),1)`
        const easedProgress = `(1-cos(PI*${progress}))/2`
        const gain = `pow(10,(${formatFfmpegNumber(duckDb)}/20)*(${easedProgress}))`
        filtersForInput.push(`volume='if(lt(t,${reactionEnd}),1,${gain})':eval=frame`)
      }

      const tailFadeStartSeconds = Math.max(
        rampEndSeconds,
        durationSeconds - INTERRUPTED_TAIL_FADE_SECONDS
      )
      const tailFadeDurationSeconds = durationSeconds - tailFadeStartSeconds
      if (tailFadeDurationSeconds > 0) {
        filtersForInput.push(
          `afade=t=out:st=${formatFfmpegNumber(
            tailFadeStartSeconds
          )}:d=${formatFfmpegNumber(tailFadeDurationSeconds)}`
        )
      }
    }
    filtersForInput.push(`adelay=${Math.round(startsMs[index])}:all=1`)
    return `[${index}:a]${filtersForInput.join(',')}[segment${index}]`
  })
  const labels = segments.map((_segment, index) => `[segment${index}]`).join('')
  const mix = `amix=inputs=${segments.length}:duration=longest:dropout_transition=0:normalize=0`
  const limiter = 'alimiter=limit=0.95:attack=5:release=50:latency=1'
  filters.push(`${labels}${mix},${limiter}[mixed]`)

  const temporaryOutput = `${outputFile}.timeline-${process.pid}-${Date.now()}.mp3`
  const args = internalAudioFiles.flatMap((audioFile) => ['-i', audioFile])
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[mixed]',
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '2',
    '-y',
    temporaryOutput
  )

  try {
    const mixStartedAt = Date.now()
    await runMediaProcess('ffmpeg', args, 'Timeline Mix failed', signal)
    const mixDurationMs = Date.now() - mixStartedAt
    const outputStat = await fs.stat(temporaryOutput).catch(() => undefined)
    if (!outputStat?.isFile() || outputStat.size === 0) {
      throw new Error('Timeline Mix produced empty audio')
    }
    await fs.rename(temporaryOutput, outputFile)
    return {
      segmentStartsMs: startsMs,
      segmentTrimStartsMs: audioBounds.map((bounds) => Math.round(bounds.trimStartMs)),
      segmentDurationsMs: durationsMs.map(Math.round),
      mixDurationMs,
    }
  } catch (error) {
    await fs.unlink(temporaryOutput).catch(() => undefined)
    throw error
  }
}

async function probeDurationMs(audioFile: string, signal?: AbortSignal): Promise<number> {
  const stdout = await runMediaProcess(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      audioFile,
    ],
    'Timeline Mix could not read input duration',
    signal
  )
  const durationSeconds = Number(stdout.trim())
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Timeline Mix input has invalid duration')
  }
  return durationSeconds * 1000
}

async function probeSegmentAudioBounds(
  audioFile: string,
  sourceDurationMs: number,
  trimLeadingSilence: boolean,
  trimTrailingSilence: boolean,
  signal?: AbortSignal
): Promise<SegmentAudioBounds> {
  const { stderr } = await runMediaProcessCapture(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      audioFile,
      '-af',
      `silencedetect=noise=${EDGE_SILENCE_THRESHOLD_DB}dB:d=${MIN_EDGE_SILENCE_SECONDS}`,
      '-f',
      'null',
      '-',
    ],
    'Timeline Mix could not inspect edge silence',
    signal
  )
  const intervals = parseSilenceIntervals(stderr, sourceDurationMs / 1000)
  const edgeToleranceSeconds = 0.1
  const leadingSilence = trimLeadingSilence
    ? intervals.find(
        (interval) =>
          interval.start <= edgeToleranceSeconds &&
          interval.end - interval.start >= MIN_EDGE_SILENCE_SECONDS
      )
    : undefined
  const trailingSilence = trimTrailingSilence
    ? [...intervals]
        .reverse()
        .find(
          (interval) =>
            interval.end >= sourceDurationMs / 1000 - edgeToleranceSeconds &&
            interval.end - interval.start >= MIN_EDGE_SILENCE_SECONDS
        )
    : undefined
  const trimStartMs = leadingSilence
    ? Math.max(0, leadingSilence.end - EDGE_SILENCE_PADDING_SECONDS) * 1000
    : 0
  const trimEndMs = trailingSilence
    ? Math.min(
        sourceDurationMs / 1000,
        trailingSilence.start + EDGE_SILENCE_PADDING_SECONDS
      ) * 1000
    : sourceDurationMs

  if (trimEndMs - trimStartMs < MIN_EDGE_SILENCE_SECONDS * 1000) {
    return { trimStartMs: 0, trimEndMs: sourceDurationMs, durationMs: sourceDurationMs }
  }
  return { trimStartMs, trimEndMs, durationMs: trimEndMs - trimStartMs }
}

function parseSilenceIntervals(
  stderr: string,
  sourceDurationSeconds: number
): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = []
  let silenceStart: number | undefined
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/)
    if (startMatch) silenceStart = Number(startMatch[1])
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/)
    if (endMatch && silenceStart !== undefined) {
      intervals.push({ start: silenceStart, end: Number(endMatch[1]) })
      silenceStart = undefined
    }
  }
  if (silenceStart !== undefined) {
    intervals.push({ start: silenceStart, end: sourceDurationSeconds })
  }
  return intervals.filter(
    (interval) =>
      Number.isFinite(interval.start) &&
      Number.isFinite(interval.end) &&
      interval.start >= 0 &&
      interval.end > interval.start
  )
}

async function runMediaProcess(
  command: 'ffmpeg' | 'ffprobe',
  args: string[],
  errorPrefix: string,
  signal?: AbortSignal
): Promise<string> {
  return (await runMediaProcessCapture(command, args, errorPrefix, signal)).stdout
}

async function runMediaProcessCapture(
  command: 'ffmpeg' | 'ffprobe',
  args: string[],
  errorPrefix: string,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.aborted ? abortError() : new Error(`${errorPrefix}: ${error.message}`))
    })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(abortError())
      else if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${errorPrefix}: ${stderr.trim() || `process exited with ${code}`}`))
    })
  })
}

function abortError(): Error {
  return Object.assign(new Error('Audio Assembly cancelled'), { name: 'AbortError' })
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate))
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function formatFfmpegNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Invalid Timeline Mix numeric value')
  return value.toFixed(6)
}

async function writeStreamingAudio(output: PassThrough, chunk: unknown): Promise<void> {
  if (output.destroyed) throw new Error('Audio Assembly output closed')
  if (output.write(chunk)) return

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      output.off('drain', onDrain)
      output.off('close', onClose)
      output.off('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('Audio Assembly output closed'))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    output.once('drain', onDrain)
    output.once('close', onClose)
    output.once('error', onError)
    if (output.destroyed) onClose()
  })
}

interface ConcatAudioFilesParams {
  fileList: string[]
  outputFile: string
  inputDir: string
}

async function concatAudioFiles({
  fileList,
  outputFile,
  inputDir,
}: ConcatAudioFilesParams): Promise<void> {
  if (!fileList.length) throw new Error('No Build Segment audio provided for assembly')

  const tempListPath = path.resolve(inputDir, 'file_list.txt')
  await fs.writeFile(tempListPath, fileList.map((file) => `file '${file}'`).join('\n'))

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(tempListPath)
        .inputFormat('concat')
        .inputOption('-safe', '0')
        .audioCodec('copy')
        .output(outputFile)
        .on('end', () => resolve())
        .on('error', (err) => reject(new Error(`Concat failed: ${err.message}`)))
        .run()
    })
  } finally {
    await fs.unlink(tempListPath).catch(() => undefined)
  }
}

export interface BuildSegmentSubtitleAssemblyRequest {
  inputDir: string
  outputFile: string
  audioFiles?: string[]
  jsonFiles?: string[]
  metadataFileName?: string
  segmentStartsMs?: number[]
  segmentTrimStartsMs?: number[]
  segmentDurationsMs?: number[]
}

export async function assembleBuildSegmentSubtitles({
  inputDir,
  outputFile,
  audioFiles,
  jsonFiles,
  metadataFileName = 'all_splits.mp3.json',
  segmentStartsMs,
  segmentTrimStartsMs,
  segmentDurationsMs,
}: BuildSegmentSubtitleAssemblyRequest): Promise<void> {
  const orderedJsonFiles = jsonFiles
    ? jsonFiles
    : segmentStartsMs
    ? audioFiles?.map((file) => `${file}.json`) || []
    : sortBySegmentIndex(audioFiles?.map((file) => `${file}.json`) || [], '.json')
  const subtitleFiles: SubtitleFiles = await Promise.all(
    orderedJsonFiles.map((file) => readJson<SubtitleFile>(file))
  )
  if (!subtitleFiles.length) throw new Error('No JSON files found for subtitles')

  const concatenatedSubtitles = segmentStartsMs
    ? placeSubtitleFilesOnTimeline(
        subtitleFiles,
        segmentStartsMs,
        segmentTrimStartsMs,
        segmentDurationsMs
      )
    : concatSubtitleFiles(subtitleFiles)
  const tempJsonPath = path.resolve(inputDir, metadataFileName)
  await fs.writeFile(tempJsonPath, JSON.stringify(concatenatedSubtitles, null, 2))
  await generateSrt(tempJsonPath, outputFile.replace('.mp3', '.srt'))
}

function sortBySegmentIndex(fileList: string[], extension: string): string[] {
  return fileList
    .filter((file) => path.extname(file).toLowerCase() === extension)
    .sort(
      (a, b) =>
        Number(path.parse(a).name.split('_')[0]) - Number(path.parse(b).name.split('_')[0])
    )
}
