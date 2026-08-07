import { describe, expect, it } from 'vitest'
import { getEngineSelection } from '@/utils/engineSelection'

describe('Engine Plugin switching', () => {
  it('repairs stale Voice filters and applies boolean subtitle capability', () => {
    const result = getEngineSelection(
      {
        selectedLanguage: 'en-US',
        selectedGender: 'Male',
        selectedVoice: 'en-US-GuyNeural',
      },
      [
        {
          Name: 'longanlingxin',
          Gender: 'Female',
          language: 'zh-CN',
          ContentCategories: [],
          VoicePersonalities: [],
        },
      ],
      false
    )

    expect(result).toEqual({
      selectedLanguage: 'zh-CN',
      selectedGender: 'All',
      selectedVoice: 'longanlingxin',
      supportsSubtitles: false,
    })
  })

  it('preserves compatible filters while selecting an available Voice', () => {
    const result = getEngineSelection(
      {
        selectedLanguage: 'zh-CN',
        selectedGender: 'Male',
        selectedVoice: 'missing-voice',
      },
      [
        {
          Name: 'longanlufeng',
          Gender: 'Male',
          language: 'zh-CN',
          ContentCategories: [],
          VoicePersonalities: [],
        },
      ],
      true
    )

    expect(result).toEqual({
      selectedLanguage: 'zh-CN',
      selectedGender: 'Male',
      selectedVoice: 'longanlufeng',
      supportsSubtitles: true,
    })
  })
})
