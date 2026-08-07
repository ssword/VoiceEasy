import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GenerationProgress from '@/components/GenerationProgress.vue'

describe('Issue #4 — buffered timeline progress', () => {
  it.each([
    ['generating-segments', '生成 Segment'],
    ['timeline-mix', '时间轴混音'],
    ['streaming', '流式生成'],
  ] as const)('shows the %s phase', (phase, label) => {
    const wrapper = mount(GenerationProgress, {
      props: { generating: true, progress: 45, phase },
    })

    expect(wrapper.text()).toContain(label)
  })

  it('does not show a generation phase while idle', () => {
    const wrapper = mount(GenerationProgress, {
      props: { generating: false, progress: 0, phase: 'idle' },
    })

    expect(wrapper.text()).toBe('')
  })
})
