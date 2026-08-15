import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import * as childProcess from 'child_process'
import { EventEmitter } from 'events'
import { Readable, PassThrough } from 'stream'
import {
  assembleBuildSegmentAudio,
  assembleBuildSegmentSubtitles,
} from '../src/services/buildSegmentAssembly.service'
import {
  createStereoToneMp3,
  createStereoToneWithLeadingSilenceMp3,
  probeAudioDuration,
  probeStereoRms,
} from './helpers/audio'

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process')
  return { ...actual, spawn: jest.fn(actual.spawn) }
})

const actualSpawn = jest.requireActual<typeof import('child_process')>('child_process').spawn

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
      await expect(fs.stat(path.join(tempDir, 'file_list.txt'))).rejects.toThrow()
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
      const interruptionStart = result.segmentStartsMs[1] / 1000
      const overlap = await probeStereoRms(outputFile, interruptionStart + 0.34, 0.04)
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

  it('lets the interrupted Segment react before smoothly ducking', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-envelope-'))
    const first = path.join(tempDir, 'first.mp3')
    const second = path.join(tempDir, 'second.mp3')
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await Promise.all([
        createStereoToneMp3(first, 440, 1.2, 'left'),
        createStereoToneMp3(second, 880, 0.8, 'right'),
      ])

      const result = await assembleBuildSegmentAudio({
        strategy: 'timeline-mix',
        segments: [
          { audioFile: first, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          { audioFile: second, interrupt: true, overlapMs: 500, duckPreviousDb: -12 },
        ],
        inputRoot: tempDir,
        outputFile,
      })

      const interruptStart = result.segmentStartsMs[1] / 1000
      const baseline = await probeStereoRms(outputFile, interruptStart - 0.12, 0.04)
      const reaction = await probeStereoRms(outputFile, interruptStart + 0.04, 0.04)
      const newSpeakerFadeIn = await probeStereoRms(outputFile, interruptStart + 0.002, 0.008)
      const newSpeakerSettled = await probeStereoRms(outputFile, interruptStart + 0.04, 0.04)
      const ramp = await probeStereoRms(outputFile, interruptStart + 0.2, 0.04)
      const ducked = await probeStereoRms(outputFile, interruptStart + 0.34, 0.04)
      const fadedTail = await probeStereoRms(outputFile, interruptStart + 0.46, 0.03)

      expect(reaction.left).toBeGreaterThan(baseline.left * 0.8)
      expect(newSpeakerFadeIn.right).toBeLessThan(newSpeakerSettled.right * 0.65)
      expect(ramp.left).toBeLessThan(baseline.left * 0.8)
      expect(ramp.left).toBeGreaterThan(baseline.left * 0.35)
      expect(ducked.left).toBeLessThan(baseline.left * 0.4)
      expect(fadedTail.left).toBeLessThan(ducked.left * 0.5)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('trims interruption-facing silence without tightening the following normal gap', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-silence-'))
    const first = path.join(tempDir, 'first.mp3')
    const second = path.join(tempDir, 'second.mp3')
    const third = path.join(tempDir, 'third.mp3')
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await Promise.all([
        createStereoToneMp3(first, 440, 1.2, 'left'),
        createStereoToneWithLeadingSilenceMp3(second, 880, 0.75, 0.25, 'right', 0.2),
        createStereoToneMp3(third, 660, 0.5, 'left'),
      ])

      const result = await assembleBuildSegmentAudio({
        strategy: 'timeline-mix',
        segments: [
          { audioFile: first, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          { audioFile: second, interrupt: true, overlapMs: 500, duckPreviousDb: -8 },
          { audioFile: third, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
        ],
        inputRoot: tempDir,
        outputFile,
      })

      const interruptStart = result.segmentStartsMs[1] / 1000
      const interruptOnset = await probeStereoRms(outputFile, interruptStart + 0.04, 0.04)
      expect(interruptOnset.right).toBeGreaterThan(0.02)
      expect(result.segmentTrimStartsMs[1]).toBeGreaterThan(150)
      expect(result.segmentDurationsMs[1]).toBeGreaterThan(950)
      expect(result.segmentDurationsMs[1]).toBeLessThan(1100)
      expect(result.segmentStartsMs[2] - result.segmentStartsMs[1]).toBeGreaterThan(950)
      expect(result.segmentStartsMs[2] - result.segmentStartsMs[1]).toBeLessThan(1100)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves silence on a normal boundary inside a Timeline Mix batch', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-normal-gap-'))
    const first = path.join(tempDir, 'first.mp3')
    const second = path.join(tempDir, 'second.mp3')
    const third = path.join(tempDir, 'third.mp3')
    const outputFile = path.join(tempDir, 'timeline.mp3')

    try {
      await Promise.all([
        createStereoToneWithLeadingSilenceMp3(first, 440, 0.5, 0.01, 'left', 0.2),
        createStereoToneWithLeadingSilenceMp3(second, 660, 0.75, 0.25, 'right', 0.2),
        createStereoToneMp3(third, 880, 0.5, 'left'),
      ])
      const firstSourceDurationMs = (await probeAudioDuration(first)) * 1000

      const result = await assembleBuildSegmentAudio({
        strategy: 'timeline-mix',
        segments: [
          { audioFile: first, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          { audioFile: second, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          { audioFile: third, interrupt: true, overlapMs: 500, duckPreviousDb: -8 },
        ],
        inputRoot: tempDir,
        outputFile,
      })

      expect(result.segmentTrimStartsMs[0]).toBe(0)
      expect(result.segmentTrimStartsMs[1]).toBe(0)
      expect(result.segmentDurationsMs[0]).toBeGreaterThan(firstSourceDurationMs * 0.95)
      expect(result.segmentStartsMs[1]).toBeGreaterThan(firstSourceDurationMs * 0.95)
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

  it.each([
    ['ffprobe failure', 'probe-failure', /could not read input duration/i],
    ['ffmpeg non-zero exit', 'mix-failure', /Timeline Mix failed/i],
    ['zero-byte ffmpeg output', 'empty-output', /empty audio/i],
  ])('cleans task output after %s', async (_name, failureMode, expectedError) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-timeline-failure-'))
    const inputFile = path.join(tempDir, 'input.mp3')
    const outputFile = path.join(tempDir, 'output.mp3')
    await fs.writeFile(inputFile, Buffer.from('non-empty internal fixture'))

    const spawn = jest.mocked(childProcess.spawn)
    spawn.mockImplementation(((command: string, args: readonly string[]) => {
      const child = new EventEmitter() as any
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = jest.fn()
      process.nextTick(() => {
        if (command === 'ffprobe') {
          if (failureMode === 'probe-failure') {
            child.stderr.end('deterministic probe failure')
            child.emit('close', 2)
          } else {
            child.stdout.end('1.0\n')
            child.emit('close', 0)
          }
          return
        }
        if (args.some((arg) => arg.includes('silencedetect='))) {
          child.emit('close', 0)
          return
        }
        if (failureMode === 'mix-failure') {
          child.stderr.end('deterministic mix failure')
          child.emit('close', 7)
        } else {
          child.emit('close', 0)
        }
      })
      return child
    }) as typeof childProcess.spawn)

    try {
      await expect(
        assembleBuildSegmentAudio({
          strategy: 'timeline-mix',
          segments: [
            { audioFile: inputFile, interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
          ],
          inputRoot: tempDir,
          outputFile,
        })
      ).rejects.toThrow(expectedError)
      await expect(fs.stat(outputFile)).rejects.toThrow()
      expect((await fs.readdir(tempDir)).filter((file) => file.includes('.timeline-'))).toEqual(
        []
      )
    } finally {
      spawn.mockImplementation(actualSpawn)
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

  it('subtracts trimmed leading silence and bounds subtitles to audible Segment duration', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyvoice-trimmed-srt-'))
    const outputFile = path.join(tempDir, 'timeline.mp3')
    const jsonFiles = [path.join(tempDir, '1.json'), path.join(tempDir, '2.json')]

    try {
      await Promise.all([
        fs.writeFile(
          jsonFiles[0],
          JSON.stringify([{ part: 'First', start: 100, end: 950 }])
        ),
        fs.writeFile(
          jsonFiles[1],
          JSON.stringify([{ part: 'Interrupted', start: 0, end: 900 }])
        ),
      ])

      await assembleBuildSegmentSubtitles({
        inputDir: tempDir,
        outputFile,
        jsonFiles,
        segmentStartsMs: [0, 600],
        segmentTrimStartsMs: [80, 240],
        segmentDurationsMs: [800, 620],
      })

      const metadata = JSON.parse(
        await fs.readFile(path.join(tempDir, 'all_splits.mp3.json'), 'utf8')
      )
      expect(metadata).toEqual([
        { part: 'First', start: 20, end: 800 },
        { part: 'Interrupted', start: 600, end: 1220 },
      ])
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})
