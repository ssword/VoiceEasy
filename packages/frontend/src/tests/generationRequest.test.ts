import { describe, expect, it } from 'vitest'
import { buildGenerateRequest } from '@/utils/generationRequest'
import type { AudioConfig } from '@/stores/audioConfig'

const config = (change: Partial<AudioConfig> = {}): AudioConfig => ({
  rate: 0,
  volume: 0,
  pitch: 0,
  voiceMode: 'preset',
  inputText: '',
  selectedLanguage: 'zh-CN',
  selectedGender: 'All',
  selectedVoice: 'zh-CN-YunxiNeural',
  engine: 'edge-tts',
  supportsSubtitles: true,
  previewText: '',
  openaiBaseUrl: '',
  openaiKey: '',
  openaiModel: '',
  previewAudioUrl: '',
  enableInterruptions: false,
  ...change,
})

describe('Issue #3 — interruption request toggle', () => {
  it('does not enable or send interruptions in preset Voice mode', () => {
    expect(
      buildGenerateRequest(config({ enableInterruptions: true }), ' Preset speech ')
    ).not.toHaveProperty('enableInterruptions')
  })

  it('sends the default-off interruption choice in LLM Recommendation mode', () => {
    expect(
      buildGenerateRequest(config({ voiceMode: 'ai' }), ' Recommended speech ')
    ).toEqual(expect.objectContaining({ useLLM: true, enableInterruptions: false }))
  })

  it('sends an explicitly enabled interruption choice in LLM Recommendation mode', () => {
    expect(
      buildGenerateRequest(
        config({ voiceMode: 'ai', enableInterruptions: true }),
        ' Recommended speech '
      )
    ).toEqual(expect.objectContaining({ useLLM: true, enableInterruptions: true }))
  })

  it('disables interruptions when the request will use Streaming', () => {
    expect(
      buildGenerateRequest(
        config({ voiceMode: 'ai', enableInterruptions: true }),
        'Long '.repeat(40)
      )
    ).toEqual(expect.objectContaining({ enableInterruptions: false }))
  })
})
