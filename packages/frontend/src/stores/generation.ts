import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Audio {
  audio: string
  file: string
  size?: number
  srt?: string
  isDownloading: boolean
  isSrtLoading: boolean
  isPlaying: boolean
  progress: number
  blobs?: Blob[]
  name?: string
  download?: () => void
}

export type GenerationPhase = 'idle' | 'generating-segments' | 'timeline-mix' | 'streaming'

export const useGenerationStore = defineStore(
  'generation',
  () => {
    const audio = ref<string | null>(null)
    const file = ref<string | null>(null)
    const progress = ref<number>(0)
    const phase = ref<GenerationPhase>('idle')
    const audioList = ref<Audio[]>([])
    function setAudio(url: string) {
      audio.value = url
    }

    function setFile(url: string) {
      file.value = url
    }

    function updateProgress(value: number) {
      progress.value = value
    }
    function updatePhase(value: GenerationPhase) {
      phase.value = value
    }
    function updateAudioList(newAudioList: Audio[]) {
      audioList.value.length = 0
      audioList.value.push(...newAudioList)
    }
    return {
      audio,
      file,
      progress,
      phase,
      setFile,
      setAudio,
      updateProgress,
      updatePhase,
      audioList,
      updateAudioList,
    }
  },
  { persist: false }
)
