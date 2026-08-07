import fs from 'fs/promises'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { PassThrough, Readable } from 'stream'
import { spawn } from 'child_process'
import { generateSrt } from './edge-tts.service'
import { readJson } from '../utils'
import {
  mergeSubtitleFiles as concatSubtitleFiles,
  SubtitleFile,
  SubtitleFiles,
} from '../utils/subtitle'
import { clampFiniteNumber } from '../utils/safeNumber'

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
    }
  | {
      strategy: 'stream'
      segments:
        | Iterable<GeneratedStreamBuildSegmentAudio>
        | AsyncIterable<GeneratedStreamBuildSegmentAudio>
      output: PassThrough
    }

/**
 * Assembles already-generated Build Segment audio in caller-supplied order.
 *
 * Engine Plugins remain responsible for synthesizing one Build Segment. This
 * boundary owns how those ordered results become the final file or response
 * stream, so future assembly strategies have one integration point.
 */
export async function assembleBuildSegmentAudio(
  request: BuildSegmentAssemblyRequest
): Promise<void> {
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
    await timelineMixAudio(Array.from(request.segments), request.inputRoot, request.outputFile)
    return
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
  outputFile: string
): Promise<void> {
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

  const durationsMs: number[] = []
  const internalAudioFiles: string[] = []
  for (const segment of segments) {
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
    durationsMs.push(await probeDurationMs(internalAudioFile))
  }

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
      startsMs[index - 1] + durationsMs[index - 1] - effectiveOverlapMs
    )
  }

  const filters = segments.map((_segment, index) => {
    const filtersForInput = [
      'aresample=44100',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
    ]
    const nextSegment = segments[index + 1]
    const nextOverlapMs = effectiveOverlapsMs[index + 1] || 0
    if (nextSegment?.interrupt && nextOverlapMs > 0) {
      const duckDb = clampFiniteNumber(nextSegment.duckPreviousDb, -18, 0)
      const duckStartSeconds = formatFfmpegNumber(
        (durationsMs[index] - nextOverlapMs) / 1000
      )
      const durationSeconds = formatFfmpegNumber(durationsMs[index] / 1000)
      const multiplier = formatFfmpegNumber(Math.pow(10, duckDb / 20))
      filtersForInput.push(
        `volume=${multiplier}:enable='between(t,${duckStartSeconds},${durationSeconds})'`
      )
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
    await runMediaProcess('ffmpeg', args, 'Timeline Mix failed')
    const outputStat = await fs.stat(temporaryOutput).catch(() => undefined)
    if (!outputStat?.isFile() || outputStat.size === 0) {
      throw new Error('Timeline Mix produced empty audio')
    }
    await fs.rename(temporaryOutput, outputFile)
  } catch (error) {
    await fs.unlink(temporaryOutput).catch(() => undefined)
    throw error
  }
}

async function probeDurationMs(audioFile: string): Promise<number> {
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
    'Timeline Mix could not read input duration'
  )
  const durationSeconds = Number(stdout.trim())
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Timeline Mix input has invalid duration')
  }
  return durationSeconds * 1000
}

async function runMediaProcess(
  command: 'ffmpeg' | 'ffprobe',
  args: string[],
  errorPrefix: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', (error) => reject(new Error(`${errorPrefix}: ${error.message}`)))
    child.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${errorPrefix}: ${stderr.trim() || `process exited with ${code}`}`))
    })
  })
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
}

export interface BuildSegmentSubtitleAssemblyRequest {
  inputDir: string
  outputFile: string
  audioFiles?: string[]
  jsonFiles?: string[]
  metadataFileName?: string
}

export async function assembleBuildSegmentSubtitles({
  inputDir,
  outputFile,
  audioFiles,
  jsonFiles,
  metadataFileName = 'all_splits.mp3.json',
}: BuildSegmentSubtitleAssemblyRequest): Promise<void> {
  const orderedJsonFiles = jsonFiles
    ? jsonFiles
    : sortBySegmentIndex(audioFiles?.map((file) => `${file}.json`) || [], '.json')
  const subtitleFiles: SubtitleFiles = await Promise.all(
    orderedJsonFiles.map((file) => readJson<SubtitleFile>(file))
  )
  if (!subtitleFiles.length) throw new Error('No JSON files found for subtitles')

  const concatenatedSubtitles = concatSubtitleFiles(subtitleFiles)
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
