import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElSelect } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Generate from '@/views/Generate.vue'
import { useAudioConfigStore } from '@/stores/audioConfig'
import type { Voice } from '@/api/tts'

const api = vi.hoisted(() => ({
  getEngines: vi.fn(),
  getVoiceList: vi.fn(),
}))

vi.mock('@/api/tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/tts')>()
  return { ...actual, getEngines: api.getEngines, getVoiceList: api.getVoiceList }
})

const edgeVoice: Voice = {
  Name: 'zh-CN-YunxiNeural',
  Gender: 'Male',
  ContentCategories: [],
  VoicePersonalities: [],
}

const doubaoVoice: Voice = {
  Name: 'zh_female_tianmeitaozi_mars_bigtts',
  Gender: 'Female',
  language: 'zh-CN',
  ContentCategories: [],
  VoicePersonalities: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Generate Engine Plugin selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.getEngines.mockReset().mockResolvedValue({
      code: 200,
      success: true,
      data: [
        { name: 'edge-tts', languages: ['zh-CN'], voices: [edgeVoice], supportsSubtitles: true },
        { name: 'doubao-tts', languages: ['zh-CN'], voices: [doubaoVoice], supportsSubtitles: false },
      ],
    })
    api.getVoiceList.mockReset().mockResolvedValue({
      code: 200,
      success: true,
      data: [edgeVoice],
    })
  })

  it('keeps subtitle capability and Voice state aligned during rapid Engine switching', async () => {
    const wrapper = mount(Generate, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    const config = useAudioConfigStore().audioConfig
    const doubaoVoices = deferred<any>()
    const edgeVoices = deferred<any>()
    api.getVoiceList.mockImplementation((engine?: string) =>
      engine === 'doubao-tts' ? doubaoVoices.promise : edgeVoices.promise
    )
    const engineSelect = wrapper.findAllComponents(ElSelect)[0]

    config.engine = 'doubao-tts'
    engineSelect.vm.$emit('change', 'doubao-tts')
    expect(config.supportsSubtitles).toBe(false)

    config.engine = 'edge-tts'
    engineSelect.vm.$emit('change', 'edge-tts')
    expect(config.supportsSubtitles).toBe(true)

    edgeVoices.resolve({ code: 200, success: true, data: [edgeVoice] })
    await flushPromises()
    doubaoVoices.resolve({ code: 200, success: true, data: [doubaoVoice] })
    await flushPromises()

    expect(config.engine).toBe('edge-tts')
    expect(config.supportsSubtitles).toBe(true)
    expect(config.selectedVoice).toBe('zh-CN-YunxiNeural')
  })

  it('falls back to the selected Engine discovery Voices when Voice List loading fails', async () => {
    const wrapper = mount(Generate, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    const config = useAudioConfigStore().audioConfig
    api.getVoiceList.mockRejectedValueOnce(new Error('Voice List unavailable'))
    const engineSelect = wrapper.findAllComponents(ElSelect)[0]

    config.engine = 'doubao-tts'
    engineSelect.vm.$emit('change', 'doubao-tts')
    await flushPromises()

    expect(config.engine).toBe('doubao-tts')
    expect(config.supportsSubtitles).toBe(false)
    expect(config.selectedVoice).toBe('zh_female_tianmeitaozi_mars_bigtts')
  })
})
