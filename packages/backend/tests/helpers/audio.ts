import { spawn } from 'child_process'

async function runMediaCommand(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args)
    const stdout: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `${command} exited with ${code}`))
      resolve(Buffer.concat(stdout))
    })
  })
}

export async function probeAudioDuration(file: string): Promise<number> {
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

export async function createStereoToneMp3(
  file: string,
  frequency: number,
  durationSeconds: number,
  channel: 'left' | 'right'
): Promise<void> {
  const pan = channel === 'left' ? 'pan=stereo|c0=c0|c1=0*c0' : 'pan=stereo|c0=0*c0|c1=c0'
  await runMediaCommand('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=${durationSeconds}:sample_rate=44100`,
    '-af',
    pan,
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '2',
    '-y',
    file,
  ])
}

export async function probeStereoRms(
  file: string,
  startSeconds: number,
  durationSeconds: number
): Promise<{ left: number; right: number }> {
  const pcm = await runMediaCommand('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(startSeconds),
    '-t',
    String(durationSeconds),
    '-i',
    file,
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-ac',
    '2',
    '-ar',
    '44100',
    'pipe:1',
  ])
  const sums = [0, 0]
  const counts = [0, 0]
  for (let offset = 0, sample = 0; offset + 4 <= pcm.length; offset += 4, sample++) {
    const channel = sample % 2
    const value = pcm.readFloatLE(offset)
    sums[channel] += value * value
    counts[channel]++
  }
  return {
    left: Math.sqrt(sums[0] / Math.max(1, counts[0])),
    right: Math.sqrt(sums[1] / Math.max(1, counts[1])),
  }
}
