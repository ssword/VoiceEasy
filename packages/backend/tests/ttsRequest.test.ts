import { normalizeTtsRequest } from '../src/services/ttsRequest'

const request = (change: Record<string, unknown> = {}) => ({
  text: 'A sufficiently long LLM Recommendation request.',
  voice: 'en-US-AriaNeural',
  useLLM: true,
  ...change,
})

describe('Issue #14 — Timeline Control request compatibility', () => {
  it('uses enableTimelineControls as the canonical request field', () => {
    expect(normalizeTtsRequest(request({ enableTimelineControls: true }))).toEqual(
      expect.objectContaining({ enableInterruptions: true })
    )
  })

  it('preserves legacy enableInterruptions requests when canonical is absent', () => {
    expect(normalizeTtsRequest(request({ enableInterruptions: true }))).toEqual(
      expect.objectContaining({ enableInterruptions: true })
    )
  })

  it('prefers enableTimelineControls when it conflicts with the legacy field', () => {
    expect(
      normalizeTtsRequest(
        request({ enableTimelineControls: false, enableInterruptions: true })
      )
    ).toEqual(expect.objectContaining({ enableInterruptions: false }))
  })
})
