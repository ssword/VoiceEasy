import fs from 'fs/promises'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { PassThrough, Readable } from 'stream'
import { generateSrt } from './edge-tts.service'
import { readJson } from '../utils'
import {
  mergeSubtitleFiles as concatSubtitleFiles,
  SubtitleFile,
  SubtitleFiles,
} from '../utils/subtitle'

export interface GeneratedFileBuildSegmentAudio {
  audioFile: string
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

  const fileList = Array.from(request.segments, (segment) => segment.audioFile)
  await concatAudioFiles({
    inputDir: request.inputDir,
    outputFile: request.outputFile,
    fileList,
  })
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
