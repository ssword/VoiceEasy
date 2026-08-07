import type { AudioConfig } from '@/stores/audioConfig'
import type { GenerateRequest } from '@/api/tts'

export function buildGenerateRequest(
  audioConfig: AudioConfig,
  text: string
): GenerateRequest {
  const params: GenerateRequest = {
    text: text.trim(),
    engine: audioConfig.engine,
  }

  if (audioConfig.voiceMode === 'preset') {
    params.voice = audioConfig.selectedVoice
    params.rate = `${audioConfig.rate > 0 ? '+' : ''}${audioConfig.rate}%`
    params.pitch = `${audioConfig.pitch > 0 ? '+' : ''}${audioConfig.pitch}Hz`
    params.volume = `${audioConfig.volume > 0 ? '+' : ''}${audioConfig.volume}%`
    return params
  }

  params.useLLM = true
  params.enableInterruptions = audioConfig.enableInterruptions
  params.openaiBaseUrl = audioConfig.openaiBaseUrl
  params.openaiKey = audioConfig.openaiKey
  params.openaiModel = audioConfig.openaiModel
  return params
}
