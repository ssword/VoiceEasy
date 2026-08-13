import {
  enforceRecommendationVoices,
  resolveRecommendationVoices,
} from '../src/services/recommendationVoices'
import { TTSEngine } from '../src/tts/types'

const fallback: VoiceConfig[] = [
  {
    Name: 'zh-CN-XiaoxiaoNeural',
    Gender: 'Female',
    language: 'zh-CN',
    VoicePersonalities: [],
    ContentCategories: [],
  },
]

function engine(voices: (string | Record<string, unknown>)[]): TTSEngine {
  return {
    name: 'fixture-tts',
    supportsSubtitles: false,
    synthesize: jest.fn(),
    getSupportedLanguages: async () => ['zh-CN'],
    getVoiceOptions: async () => voices,
  }
}

describe('Ticket 03 — shared recommendation Voice resolution', () => {
  it('preserves structured engine Voice metadata', async () => {
    const resolved = await resolveRecommendationVoices(
      'fixture-tts',
      fallback,
      engine([
        {
          Name: 'fixture-sichuan',
          cnName: '川味角色',
          Gender: 'Male',
          language: 'zh-CN',
          VoicePersonalities: ['四川口音'],
          ContentCategories: ['Conversation'],
        },
      ])
    )

    expect(resolved).toEqual([
      expect.objectContaining({
        Name: 'fixture-sichuan',
        cnName: '川味角色',
        Gender: 'Male',
        language: 'zh-CN',
        VoicePersonalities: ['四川口音'],
      }),
    ])
  })

  it('normalizes string-only engine Voices to the structured prompt contract', async () => {
    await expect(
      resolveRecommendationVoices('fixture-tts', fallback, engine(['fixture-basic']))
    ).resolves.toEqual([
      {
        Name: 'fixture-basic',
        Gender: 'All',
        ContentCategories: [],
        VoicePersonalities: [],
      },
    ])
  })
})

describe('LLM Recommendation Voice List boundary', () => {
  const doubaoVoices = [
    {
      Name: 'configured-doubao-voice',
      Gender: 'All',
      ContentCategories: [],
      VoicePersonalities: [],
    },
    {
      Name: 'documented-doubao-voice',
      Gender: 'Female',
      ContentCategories: [],
      VoicePersonalities: [],
    },
  ]

  it('keeps selected Engine Voices and replaces cross-Engine recommendations', () => {
    expect(
      enforceRecommendationVoices(
        [
          { text: 'valid', name: 'documented-doubao-voice' },
          { text: 'cross-engine', name: 'zh-CN-XiaoxiaoNeural' },
          { text: 'missing' },
        ],
        doubaoVoices
      )
    ).toEqual([
      { text: 'valid', name: 'documented-doubao-voice' },
      { text: 'cross-engine', name: 'configured-doubao-voice' },
      { text: 'missing', name: 'configured-doubao-voice' },
    ])
  })

  it('rejects an empty selected Engine Voice List', () => {
    expect(() => enforceRecommendationVoices([{ text: 'fixture' }], [])).toThrow(
      'selected TTS Engine has no Voices'
    )
  })
})
