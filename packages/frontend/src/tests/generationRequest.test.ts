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
  enableTimelineControls: false,
  ...change,
})

describe('Issue #14 — Timeline Control request toggle', () => {
  it('does not send Timeline Controls in preset Voice mode', () => {
    expect(
      buildGenerateRequest(config({ enableTimelineControls: true }), ' Preset speech ')
    ).not.toHaveProperty('enableTimelineControls')
  })

  it('sends the default-off Timeline Control choice in LLM Recommendation mode', () => {
    expect(
      buildGenerateRequest(config({ voiceMode: 'ai' }), ' Recommended speech ')
    ).toEqual(expect.objectContaining({ useLLM: true, enableTimelineControls: false }))
  })

  it('sends an explicitly enabled Timeline Control choice in LLM Recommendation mode', () => {
    expect(
      buildGenerateRequest(
        config({ voiceMode: 'ai', enableTimelineControls: true }),
        ' Recommended speech '
      )
    ).toEqual(expect.objectContaining({ useLLM: true, enableTimelineControls: true }))
  })

  it('preserves Timeline Controls when the request will use long-text Streaming', () => {
    expect(
      buildGenerateRequest(
        config({ voiceMode: 'ai', enableTimelineControls: true }),
        'Long '.repeat(40)
      )
    ).toEqual(expect.objectContaining({ enableTimelineControls: true }))
  })

  it('enables Timeline Controls when long text contains a manual control tag', () => {
    expect(
      buildGenerateRequest(
        config({ voiceMode: 'ai', enableTimelineControls: false }),
        `医生：您哪里不舒服？患者：[interrupt overlap=1000 duck=-12]就是心口这一块。${'后续内容'.repeat(50)}`
      )
    ).toEqual(expect.objectContaining({ enableTimelineControls: true }))
  })
})
