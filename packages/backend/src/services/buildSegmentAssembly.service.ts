import fs from 'fs/promises'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { once } from 'events'
import { PassThrough, Readable } from 'stream'
import { generateSrt } from './edge-tts.service'
import { readJson } from '../utils'
import { mergeSubtitleFiles, SubtitleFile, SubtitleFiles } from '../utils/subtitle'

export interface GeneratedBuildSegmentAudio {
  audio: string | Readable
}

type GeneratedBuildSegmentAudioSequence =
  | Iterable<GeneratedBuildSegmentAudio>
  | AsyncIterable<GeneratedBuildSegmentAudio>

type AssemblyDestination =
  | { kind: 'file'; inputDir: string; outputFile: string }
  | { kind: 'stream'; output: PassThrough }

export interface BuildSegmentAssemblyRequest {
  segments: GeneratedBuildSegmentAudioSequence
  destination: AssemblyDestination
}

/**
 * Assembles already-generated Build Segment audio in caller-supplied order.
 *
 * Engine Plugins remain responsible for synthesizing one Build Segment. This
 * boundary owns how those ordered results become the final file or response
 * stream, so future assembly strategies have one integration point.
 */
export async function assembleBuildSegmentAudio({
  segments,
  destination,
}: BuildSegmentAssemblyRequest): Promise<void> {
  if (destination.kind === 'stream') {
    let segmentCount = 0
    for await (const segment of segments) {
      if (!(segment.audio instanceof Readable)) {
        throw new TypeError('Streaming assembly requires Readable Build Segment audio')
      }
      segmentCount++
      for await (const chunk of segment.audio) {
        if (!destination.output.write(chunk)) await once(destination.output, 'drain')
      }
    }
    if (!segmentCount) throw new Error('No Build Segment audio provided for assembly')
    destination.output.end()
    return
  }

  const fileList: string[] = []
  for await (const segment of segments) {
    if (typeof segment.audio !== 'string') {
      throw new TypeError('File assembly requires file-backed Build Segment audio')
    }
    fileList.push(segment.audio)
  }
  await concatAudioFiles({ ...destination, fileList })
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
}

export async function assembleBuildSegmentSubtitles({
  inputDir,
  outputFile,
  audioFiles,
  jsonFiles,
}: BuildSegmentSubtitleAssemblyRequest): Promise<void> {
  const orderedJsonFiles = jsonFiles
    ? jsonFiles
    : sortBySegmentIndex(audioFiles?.map((file) => `${file}.json`) || [], '.json')
  const subtitleFiles: SubtitleFiles = await Promise.all(
    orderedJsonFiles.map((file) => readJson<SubtitleFile>(file))
  )
  if (!subtitleFiles.length) throw new Error('No JSON files found for subtitles')

  const mergedJson = mergeSubtitleFiles(subtitleFiles)
  const tempJsonPath = path.resolve(inputDir, 'all_splits.mp3.json')
  await fs.writeFile(tempJsonPath, JSON.stringify(mergedJson, null, 2))
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
