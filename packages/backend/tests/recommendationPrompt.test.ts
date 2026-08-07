import { getPrompt } from '../src/llm/prompt/generateSegment'

const voices: VoiceConfig[] = [
  {
    Name: 'warm-narrator',
    cnName: '温暖旁白',
    Gender: 'Female',
    language: 'zh-CN',
    VoicePersonalities: ['自然亲和音'],
    ContentCategories: ['Narration'],
  },
  {
    Name: 'sichuan-character',
    cnName: '川味角色',
    Gender: 'Male',
    language: 'zh-CN',
    VoicePersonalities: ['四川口音'],
    ContentCategories: ['Conversation'],
  },
]

describe('Ticket 03 — domain-neutral LLM Recommendation prompt', () => {
  it('keeps structured Voice metadata and does not impose a medical domain on advertising copy', () => {
    const prompt = getPrompt(
      'cn',
      voices,
      '新品咖啡上市，清晨第一口就能唤醒活力。',
      'qwen-audio-tts'
    )

    expect(prompt).toContain('"Name": "warm-narrator"')
    expect(prompt).toContain('"language": "zh-CN"')
    expect(prompt).toContain('"Gender": "Female"')
    expect(prompt).toContain('"VoicePersonalities"')
    expect(prompt).toContain('新品咖啡上市')
    expect(prompt).not.toMatch(/主要场景都是医院|医生|病人|患者/)
  })

  it('asks the model to infer roles and dialect from medical content without a medical-only rule', () => {
    const prompt = getPrompt(
      'cn',
      voices,
      '医生问：“最近哪里不舒服？”患者用四川话回答：“胃有点痛。”',
      'qwen-audio-tts'
    )

    expect(prompt).toContain('医生问')
    expect(prompt).toContain('患者用四川话回答')
    expect(prompt).toContain('sichuan-character')
    expect(prompt).toMatch(/根据(?:文字|内容|上下文).*推断|从(?:文字|内容|上下文).*识别/)
    expect(prompt).not.toContain('主要场景都是医院')
  })
})

describe('Issue #3 — interruption-aware LLM Recommendation prompt', () => {
  it('permits interruption fields only for explicit interruption cues', () => {
    const prompt = getPrompt(
      'eng',
      voices,
      'Morgan said, "I think—" "No, that is wrong!" Riley interrupted.',
      'edge-tts',
      true
    )

    expect(prompt).toContain('interrupt')
    expect(prompt).toContain('overlapMs')
    expect(prompt).toContain('duckPreviousDb')
    expect(prompt).toMatch(/unfinished speech/i)
    expect(prompt).toMatch(/urgent rebuttal/i)
    expect(prompt).toMatch(/must not add, delete, duplicate, rewrite, or reorder/i)
  })

  it('does not offer interruption fields when the capability is disabled', () => {
    const prompt = getPrompt('eng', voices, 'A calm exchange.', 'edge-tts', false)

    expect(prompt).not.toContain('overlapMs')
    expect(prompt).not.toContain('duckPreviousDb')
  })
})
