import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable, PassThrough } from 'stream'
import {
  assembleBuildSegmentAudio,
  assembleBuildSegmentSubtitles,
} from '../src/services/buildSegmentAssembly.service'
import { probeAudioDuration } from './helpers/audio'

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

describe('Build Segment audio assembly boundary', () => {
  it('streams generated Build Segment audio in the supplied order', async () => {
    async function* generatedAudio() {
      yield { audioStream: Readable.from([Buffer.from('first-')]) }
      yield { audioStream: Readable.from([Buffer.from('second')]) }
    }

    const output = new PassThrough()
    const assembled = readAll(output)

    await assembleBuildSegmentAudio({
      strategy: 'stream',
      segments: generatedAudio(),
      output,
    })

    await expect(assembled).resolves.toEqual(Buffer.from('first-second'))
  })

  it('preserves an empty Streaming result as an empty successful response', async () => {
    const output = new PassThrough()
    const assembled = readAll(output)

    await assembleBuildSegmentAudio({
      strategy: 'stream',
      segments: [],
      output,
    })

    await expect(assembled).resolves.toEqual(Buffer.alloc(0))
  })

  it('stops active Build Segment audio when the Streaming destination closes', async () => {
    const audioStream = new PassThrough()
    const output = new PassThrough({ highWaterMark: 1 })
    const assembly = assembleBuildSegmentAudio({
      strategy: 'stream',
      segments: [{ audioStream }],
      output,
    })

    audioStream.write(Buffer.alloc(1024))
    await new Promise<void>((resolve) => setImmediate(resolve))
    output.destroy()

    await expect(assembly).rejects.toThrow('Audio Assembly output closed')
    expect(audioStream.destroyed).toBe(true)
  })

  it('uses the existing Concat strategy to create playable audio', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-assembly-'))
    const fixture = path.resolve(__dirname, '../../frontend/src/assets/notification.mp3')
    const first = path.join(tempDir, '1_splits.mp3')
    const second = path.join(tempDir, '2_splits.mp3')
    const outputFile = path.join(tempDir, 'assembled.mp3')

    try {
      await Promise.all([fs.copyFile(fixture, first), fs.copyFile(fixture, second)])
      const sourceDuration = await probeAudioDuration(fixture)

      await assembleBuildSegmentAudio({
        strategy: 'concat',
        segments: [{ audioFile: first }, { audioFile: second }],
        inputDir: tempDir,
        outputFile,
      })

      const assembledDuration = await probeAudioDuration(outputFile)
      expect(assembledDuration).toBeGreaterThan(sourceDuration * 1.8)
      expect(assembledDuration).toBeLessThan(sourceDuration * 2.2)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves the supplied Streaming subtitle sidecar order', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-subtitle-assembly-'))
    const first = path.join(tempDir, 'audio.mp3.json.0')
    const second = path.join(tempDir, 'audio.mp3.json.1')
    const outputFile = path.join(tempDir, 'assembled.mp3')

    try {
      await fs.writeFile(first, JSON.stringify([{ part: 'First', start: 0, end: 100 }]))
      await fs.writeFile(second, JSON.stringify([{ part: 'Second', start: 0, end: 100 }]))

      await assembleBuildSegmentSubtitles({
        inputDir: tempDir,
        outputFile,
        jsonFiles: [first, second],
      })

      const subtitles = await fs.readFile(outputFile.replace('.mp3', '.srt'), 'utf8')
      expect(subtitles.indexOf('First')).toBeLessThan(subtitles.indexOf('Second'))
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})
