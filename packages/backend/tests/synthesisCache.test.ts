import { createSynthesisCacheKey } from '../src/services/synthesisCache'

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
