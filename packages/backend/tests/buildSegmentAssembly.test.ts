import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable, PassThrough } from 'stream'
import {
  assembleBuildSegmentAudio,
  assembleBuildSegmentSubtitles,
} from '../src/services/buildSegmentAssembly.service'
import { createStereoToneMp3, probeAudioDuration, probeStereoRms } from './helpers/audio'

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

  it('uses real media duration to overlap tracks and duck the previous Segment', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-'))
    const first = path.join(tempDir, 'first.mp3')
    const second = path.join(tempDir, 'second.mp3')
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await Promise.all([
        createStereoToneMp3(first, 440, 1, 'left'),
        createStereoToneMp3(second, 880, 1, 'right'),
      ])

      const result = await assembleBuildSegmentAudio({
        strategy: 'timeline-mix',
        segments: [
          { audioFile: first, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          { audioFile: second, interrupt: true, overlapMs: 400, duckPreviousDb: -12 },
        ],
        inputRoot: tempDir,
        outputFile,
      })

      const duration = await probeAudioDuration(outputFile)
      expect(duration).toBeGreaterThan(1.5)
      expect(duration).toBeLessThan(1.7)

      const beforeOverlap = await probeStereoRms(outputFile, 0.2, 0.2)
      const overlap = await probeStereoRms(outputFile, 0.7, 0.2)
      expect(beforeOverlap.left).toBeGreaterThan(0.02)
      expect(beforeOverlap.right).toBeLessThan(0.002)
      expect(overlap.left).toBeGreaterThan(0.005)
      expect(overlap.right).toBeGreaterThan(0.02)
      expect(overlap.left).toBeLessThan(overlap.right * 0.5)
      expect(result.segmentStartsMs).toHaveLength(2)
      expect(result.segmentStartsMs[0]).toBe(0)
      expect(Number.isInteger(result.segmentStartsMs[1])).toBe(true)
      expect(result.segmentStartsMs[1]).toBeGreaterThan(550)
      expect(result.segmentStartsMs[1]).toBeLessThan(700)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('converges overlap to the previous duration without creating negative time', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-bound-'))
    const first = path.join(tempDir, 'first.mp3')
    const second = path.join(tempDir, 'second.mp3')
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await Promise.all([
        createStereoToneMp3(first, 440, 0.2, 'left'),
        createStereoToneMp3(second, 880, 1, 'right'),
      ])
      const result = await assembleBuildSegmentAudio({
        strategy: 'timeline-mix',
        segments: [
          { audioFile: first, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          { audioFile: second, interrupt: true, overlapMs: 1000, duckPreviousDb: -6 },
        ],
        inputRoot: tempDir,
        outputFile,
      })

      const duration = await probeAudioDuration(outputFile)
      expect(duration).toBeGreaterThan(0.9)
      expect(duration).toBeLessThan(1.1)
      expect(result.segmentStartsMs).toEqual([0, 0])
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('returns actual starts for consecutive interruptions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-consecutive-'))
    const audioFiles = ['first.mp3', 'second.mp3', 'third.mp3'].map((file) =>
      path.join(tempDir, file)
    )
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await Promise.all([
        createStereoToneMp3(audioFiles[0], 440, 1, 'left'),
        createStereoToneMp3(audioFiles[1], 660, 1, 'right'),
        createStereoToneMp3(audioFiles[2], 880, 1, 'left'),
      ])
      const result = await assembleBuildSegmentAudio({
        strategy: 'timeline-mix',
        segments: [
          { audioFile: audioFiles[0], interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          { audioFile: audioFiles[1], interrupt: true, overlapMs: 400, duckPreviousDb: -8 },
          { audioFile: audioFiles[2], interrupt: true, overlapMs: 300, duckPreviousDb: -10 },
        ],
        inputRoot: tempDir,
        outputFile,
      })

      expect(result.segmentStartsMs).toHaveLength(3)
      expect(result.segmentStartsMs.every(Number.isInteger)).toBe(true)
      expect(result.segmentStartsMs[1]).toBeGreaterThan(550)
      expect(result.segmentStartsMs[1]).toBeLessThan(700)
      expect(result.segmentStartsMs[2] - result.segmentStartsMs[1]).toBeGreaterThan(650)
      expect(result.segmentStartsMs[2] - result.segmentStartsMs[1]).toBeLessThan(800)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('fails safely when Timeline Mix input is missing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-missing-'))
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await expect(
        assembleBuildSegmentAudio({
          strategy: 'timeline-mix',
          segments: [
            {
              audioFile: path.join(tempDir, 'missing.mp3'),
              interrupt: false,
              overlapMs: 0,
              duckPreviousDb: 0,
            },
          ],
          inputRoot: tempDir,
          outputFile,
        })
      ).rejects.toThrow(/Timeline Mix input/i)
      await expect(fs.stat(outputFile)).rejects.toThrow()
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects Timeline Mix media outside the caller-owned internal root', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-root-'))
    const fixture = path.resolve(__dirname, '../../frontend/src/assets/notification.mp3')
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await expect(
        assembleBuildSegmentAudio({
          strategy: 'timeline-mix',
          segments: [
            { audioFile: fixture, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          ],
          inputRoot: tempDir,
          outputFile,
        })
      ).rejects.toThrow(/internal path/i)
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
      const metadata = JSON.parse(
        await fs.readFile(path.join(tempDir, 'all_splits.mp3.json'), 'utf8')
      )
      expect(metadata).toEqual([
        { part: 'First', start: 0, end: 100 },
        { part: 'Second', start: 100, end: 200 },
      ])
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'ordinary order',
      startsMs: [0, 1000],
      files: [
        [{ part: 'Narrator', start: 100, end: 900 }],
        [{ part: 'Reply', start: 0, end: 700 }],
      ],
      expected: [
        { part: 'Narrator', start: 100, end: 900 },
        { part: 'Reply', start: 1000, end: 1700 },
      ],
    },
    {
      name: 'one interruption',
      startsMs: [0, 600],
      files: [
        [{ part: 'Role A', start: 100, end: 900 }],
        [{ part: 'Role B', start: 0, end: 700 }],
      ],
      expected: [
        { part: 'Role A', start: 100, end: 900 },
        { part: 'Role B', start: 600, end: 1300 },
      ],
    },
    {
      name: 'consecutive interruptions',
      startsMs: [0, 600, 1000],
      files: [
        [{ part: 'Role A', start: 0, end: 900 }],
        [{ part: 'Role B', start: 0, end: 700 }],
        [{ part: 'Role C', start: 50, end: 650 }],
      ],
      expected: [
        { part: 'Role A', start: 0, end: 900 },
        { part: 'Role B', start: 600, end: 1300 },
        { part: 'Role C', start: 1050, end: 1650 },
      ],
    },
    {
      name: 'overlap bounded to the previous Segment',
      startsMs: [0, 0],
      files: [
        [{ part: 'Brief Role A', start: 0, end: 200 }],
        [{ part: 'Role B', start: 20, end: 820 }],
      ],
      expected: [
        { part: 'Brief Role A', start: 0, end: 200 },
        { part: 'Role B', start: 20, end: 820 },
      ],
    },
  ])('places subtitles on the Timeline Mix for $name', async ({ startsMs, files, expected }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-srt-'))
    const outputFile = path.join(tempDir, 'timeline.mp3')
    const jsonFiles = files.map((_file, index) => path.join(tempDir, `${index + 1}.json`))

    try {
      await Promise.all(
        files.map((file, index) => fs.writeFile(jsonFiles[index], JSON.stringify(file)))
      )

      await assembleBuildSegmentSubtitles({
        inputDir: tempDir,
        outputFile,
        jsonFiles,
        segmentStartsMs: startsMs,
      })

      const metadata = JSON.parse(
        await fs.readFile(path.join(tempDir, 'all_splits.mp3.json'), 'utf8')
      )
      expect(metadata).toEqual(expected)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps current Segment order when cached audio filenames have older indexes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-cached-srt-order-'))
    const cachedSecond = path.join(tempDir, '2_splits.mp3')
    const cachedFirst = path.join(tempDir, '1_splits.mp3')
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await Promise.all([
        fs.writeFile(
          `${cachedSecond}.json`,
          JSON.stringify([{ part: 'Current first', start: 0, end: 500 }])
        ),
        fs.writeFile(
          `${cachedFirst}.json`,
          JSON.stringify([{ part: 'Current second', start: 0, end: 500 }])
        ),
      ])

      await assembleBuildSegmentSubtitles({
        inputDir: tempDir,
        outputFile,
        audioFiles: [cachedSecond, cachedFirst],
        segmentStartsMs: [0, 600],
      })

      const metadata = JSON.parse(
        await fs.readFile(path.join(tempDir, 'all_splits.mp3.json'), 'utf8')
      )
      expect(metadata).toEqual([
        { part: 'Current first', start: 0, end: 500 },
        { part: 'Current second', start: 600, end: 1100 },
      ])
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})
