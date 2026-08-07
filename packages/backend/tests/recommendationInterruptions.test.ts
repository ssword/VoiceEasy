import { normalizeRecommendationSegments } from '../src/services/recommendationInterruptions'
import { normalizeTtsRequest } from '../src/services/ttsRequest'

describe('Issue #3 — LLM Recommendation interruption contract', () => {
  it('keeps interruptions disabled when the request field is omitted', () => {
    expect(
      normalizeTtsRequest({
        text: '  A short recommendation request.  ',
        voice: 'en-US-AriaNeural',
      } as any)
    ).toEqual(expect.objectContaining({ enableInterruptions: false }))
  })

  it('removes interruption metadata unless the user enabled it', () => {
    const [first, second] = normalizeRecommendationSegments(
      [
        { text: 'I was saying—', interrupt: true, overlapMs: 400, duckPreviousDb: -9 },
        { text: 'No, listen!', interrupt: true, overlapMs: 400, duckPreviousDb: -9 },
      ],
      false
    )

    const serial = { interrupt: false, overlapMs: 0, duckPreviousDb: 0 }
    expect(first).toEqual(expect.objectContaining(serial))
    expect(second).toEqual(expect.objectContaining(serial))
  })

  it('prevents the first Segment from interrupting and bounds untrusted numeric fields', () => {
    const [first, second, third, fourth] = normalizeRecommendationSegments(
      [
        { text: 'First', interrupt: true, overlapMs: 500, duckPreviousDb: -6 },
        { text: 'Second', interrupt: true, overlapMs: 5000, duckPreviousDb: -99 },
        { text: 'Third', interrupt: true, overlapMs: Number.NaN, duckPreviousDb: Infinity },
        { text: 'Fourth', interrupt: 'yes', overlapMs: 300, duckPreviousDb: -3 },
      ],
      true
    )

    const serial = { interrupt: false, overlapMs: 0, duckPreviousDb: 0 }
    expect(first).toEqual(expect.objectContaining(serial))
    expect(second).toEqual(
      expect.objectContaining({ interrupt: true, overlapMs: 1000, duckPreviousDb: -18 })
    )
    expect(third).toEqual(expect.objectContaining(serial))
    expect(fourth).toEqual(expect.objectContaining(serial))
  })
})
