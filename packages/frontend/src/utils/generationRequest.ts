import type { AudioConfig } from '@/stores/audioConfig'
import type { GenerateRequest } from '@/api/tts'

const hasTimelineControlTag = (text: string) =>
  /\[(?:interrupt|pause)(?:\s+[^\]\r\n]*)?\]/i.test(text)

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
  params.enableTimelineControls =
    audioConfig.enableTimelineControls || hasTimelineControlTag(params.text)
  params.openaiBaseUrl = audioConfig.openaiBaseUrl
  params.openaiKey = audioConfig.openaiKey
  params.openaiModel = audioConfig.openaiModel
  return params
}
