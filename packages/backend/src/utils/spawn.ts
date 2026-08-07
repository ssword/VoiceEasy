import { spawn } from 'child_process'
import { logger } from './logger'

//TODO: Node.js implementation of edge-tts
export function runEdgeTTS(
  params: TTSParams
): Promise<{ audio: string; srt: string; success: boolean }> {
  return new Promise((resolve, reject) => {
    const srt = params.output.replace('.mp3', '.srt')
    logger.info('EdgeTTS subprocess started', {
      voice: params.voice,
      textLength: params.text.length,
      volume: params.volume,
      pitch: params.pitch,
      rate: params.rate,
    })
    const child = spawn(
      'edge-tts',
      [
        '--text',
        params.text,
        '--voice',
        params.voice,
        `--volume=${params.volume}`,
        `--pitc=${params.pitch}`,
        `--rate=${params.rate}`,
        '--write-media',
        params.output,
        '--write-sub',
        srt,
      ],
      { cwd: process.cwd() }
    )

    let stdout = ''
    let stderr = ''
    // 实时收集标准输出
    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    // 实时收集错误输出
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    // 进程结束
    child.on('close', (code) => {
      if (code === 0) {
        logger.info('EdgeTTS subprocess completed')
        resolve({ success: true, audio: params.output, srt })
      } else {
        reject({
          success: false,
          error: stderr || `Process exited with code ${code}`,
        })
      }
    })
    // 错误处理
    child.on('error', (error) => {
      reject({
        success: false,
        error: error.message,
      })
    })
  })
}
