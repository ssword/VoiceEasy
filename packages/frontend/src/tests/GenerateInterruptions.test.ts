import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElSwitch } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Generate from '@/views/Generate.vue'
import { useAudioConfigStore } from '@/stores/audioConfig'

vi.mock('@/api/tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/tts')>()
  return {
    ...actual,
    getEngines: vi.fn(async () => ({ code: 200, success: true, data: [] })),
    getVoiceList: vi.fn(async () => ({ code: 200, success: true, data: [] })),
  }
})

describe('Timeline Mix controls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('allows interruptions for long-text Streaming requests', async () => {
    const config = useAudioConfigStore().audioConfig
    config.voiceMode = 'ai'
    config.inputText = '长文本'.repeat(250)

    const wrapper = mount(Generate, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    expect(wrapper.findComponent(ElSwitch).props('disabled')).toBe(false)
  })
})
