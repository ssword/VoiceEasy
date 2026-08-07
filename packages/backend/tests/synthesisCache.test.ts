import {
  createFinalAudioCacheIdentity,
  createFinalAudioCacheKey,
  createSynthesisCacheKey,
  TIMELINE_MIX_ALGORITHM_VERSION,
} from '../src/services/synthesisCache'

const baseline = {
  engine: 'qwen-audio-tts',
  cacheNamespace: 'qwen-audio-tts:qwen-audio-3.0-tts-plus',
  text: '同一段待合成文本',
  voice: 'longanlingxin',
  rate: '+0%',
  pitch: '+0Hz',
  volume: '+0%',
  instruction: '使用温暖的语气',
  outputFormat: 'mp3',
  sampleRate: 24000,
  useLLM: false,
  recommendationModel: '',
}

describe('Ticket 02 — synthesis cache identity', () => {
  it.each([
    ['Engine Plugin', { engine: 'cosyvoice-tts' }],
    ['model namespace', { cacheNamespace: 'qwen-audio-tts:qwen-audio-3.0-tts-flash' }],
    ['instruction', { instruction: '使用严肃的语气' }],
    ['output format', { outputFormat: 'wav' }],
    ['sample rate', { sampleRate: 16000 }],
    ['LLM Recommendation mode', { useLLM: true }],
    ['LLM Recommendation model', { useLLM: true, recommendationModel: 'another-model' }],
    ['interruption assembly mode', { useLLM: true, enableInterruptions: true }],
  ])('isolates cache entries when %s changes', (_field, change) => {
    expect(createSynthesisCacheKey({ ...baseline, ...change })).not.toBe(
      createSynthesisCacheKey(baseline)
    )
  })

  it('canonically hashes the same typed identity regardless of property insertion order', () => {
    const reversed = Object.fromEntries(Object.entries(baseline).reverse()) as typeof baseline
    expect(createSynthesisCacheKey(reversed)).toBe(createSynthesisCacheKey(baseline))
  })
})

describe('Issue #6 — final Audio Assembly cache identity', () => {
  const segments = [
    { ...baseline, text: 'First Segment', interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
    {
      ...baseline,
      text: 'Second Segment',
      interrupt: true,
      overlapMs: 400,
      duckPreviousDb: -12,
    },
  ]

  it('includes the interruption switch, normalized timeline, and mixer version', () => {
    const identity = createFinalAudioCacheIdentity({
      enableInterruptions: true,
      segments,
    })

    expect(identity).toEqual(
      expect.objectContaining({
        cacheVersion: 2,
        enableInterruptions: true,
        mode: 'timeline-mix',
        timelineMixAlgorithmVersion: TIMELINE_MIX_ALGORITHM_VERSION,
        timeline: [
          expect.objectContaining({ interrupt: false, overlapMs: 0, duckPreviousDb: 0 }),
          expect.objectContaining({ interrupt: true, overlapMs: 400, duckPreviousDb: -12 }),
        ],
      })
    )
  })

  it.each([
    ['interruption switch', { enableInterruptions: false }],
    [
      'overlap',
      { segments: [segments[0], { ...segments[1], overlapMs: 250 }] },
    ],
    [
      'ducking',
      { segments: [segments[0], { ...segments[1], duckPreviousDb: -8 }] },
    ],
  ])('isolates final audio when %s changes', (_name, change) => {
    expect(
      createFinalAudioCacheKey({ enableInterruptions: true, segments, ...change })
    ).not.toBe(createFinalAudioCacheKey({ enableInterruptions: true, segments }))
  })

  it('normalizes unsafe timeline values before hashing', () => {
    const unsafe = [
      { ...segments[0], interrupt: true, overlapMs: 999, duckPreviousDb: -9 },
      { ...segments[1], overlapMs: 5000, duckPreviousDb: -99 },
    ]
    const normalized = [
      { ...segments[0], interrupt: false, overlapMs: 0, duckPreviousDb: 0 },
      { ...segments[1], overlapMs: 1000, duckPreviousDb: -18 },
    ]

    expect(
      createFinalAudioCacheKey({ enableInterruptions: true, segments: unsafe })
    ).toBe(createFinalAudioCacheKey({ enableInterruptions: true, segments: normalized }))
  })

  it('keeps Segment synthesis reusable when only timeline fields change', () => {
    expect(createSynthesisCacheKey(segments[1])).toBe(
      createSynthesisCacheKey({ ...segments[1], overlapMs: 200, duckPreviousDb: -6 })
    )
  })
})
