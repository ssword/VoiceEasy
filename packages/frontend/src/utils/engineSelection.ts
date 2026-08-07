import type { Voice } from '@/api/tts'

interface CurrentVoiceSelection {
  selectedLanguage: string
  selectedGender: string
  selectedVoice: string
}

interface EngineSelection extends CurrentVoiceSelection {
  supportsSubtitles: boolean
}

export const getVoiceLanguage = (voice: Voice) =>
  voice.language || voice.Name.split('-').slice(0, 2).join('-')

export function getEngineSelection(
  current: CurrentVoiceSelection,
  voices: Voice[],
  supportsSubtitles: boolean
): EngineSelection {
  let { selectedLanguage, selectedGender, selectedVoice } = current
  if (!voices.length) return { ...current, supportsSubtitles }

  const matchingVoices = () =>
    voices.filter((voice) => {
      const language = getVoiceLanguage(voice)
      const matchesLanguage =
        selectedLanguage === language ||
        language.startsWith(selectedLanguage) ||
        voice.Name.startsWith(selectedLanguage)
      const matchesGender = selectedGender === 'All' || voice.Gender === selectedGender
      return matchesLanguage && matchesGender
    })

  let available = matchingVoices()
  if (!available.length) {
    selectedLanguage = getVoiceLanguage(voices[0])
    selectedGender = 'All'
    available = matchingVoices()
  }
  if (!available.some((voice) => voice.Name === selectedVoice)) {
    selectedVoice = available[0]?.Name || voices[0].Name
  }

  return { selectedLanguage, selectedGender, selectedVoice, supportsSubtitles }
}
