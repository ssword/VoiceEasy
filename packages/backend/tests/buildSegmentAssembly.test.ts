import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { Readable, PassThrough } from 'stream'
import {
  assembleBuildSegmentAudio,
  assembleBuildSegmentSubtitles,
} from '../src/services/buildSegmentAssembly.service'

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `ffprobe exited with ${code}`))
      resolve(Number(stdout.trim()))
    })
  })
}

describe('Build Segment audio assembly boundary', () => {
  it('streams generated Build Segment audio in the supplied order', async () => {
    async function* generatedAudio() {
      yield { audio: Readable.from([Buffer.from('first-')]) }
      yield { audio: Readable.from([Buffer.from('second')]) }
    }

    const output = new PassThrough()
    const assembled = readAll(output)

    await assembleBuildSegmentAudio({
      segments: generatedAudio(),
      destination: { kind: 'stream', output },
    })

    await expect(assembled).resolves.toEqual(Buffer.from('first-second'))
  })

  it('uses the existing Concat strategy to create playable audio', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-assembly-'))
    const fixture = path.resolve(__dirname, '../../frontend/src/assets/notification.mp3')
    const first = path.join(tempDir, '1_splits.mp3')
    const second = path.join(tempDir, '2_splits.mp3')
    const outputFile = path.join(tempDir, 'assembled.mp3')

    try {
      await Promise.all([fs.copyFile(fixture, first), fs.copyFile(fixture, second)])
      const sourceDuration = await probeDuration(fixture)

      await assembleBuildSegmentAudio({
        segments: [{ audio: first }, { audio: second }],
        destination: { kind: 'file', inputDir: tempDir, outputFile },
      })

      const assembledDuration = await probeDuration(outputFile)
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
