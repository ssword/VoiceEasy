const cnTemplate = (voiceList: VoiceConfig[], text: string) => `
我希望你根据以下声音配置和一段文字内容，为文字配音提供优化建议。任务包括：
1. 将文字按场景、角色、旁白分割。
2. 根据角色的性格、对话语气，从声音配置中推荐合适的"Name"。
3. 为每段推荐合理的"rate"（语速）、"volume"（音量）、"pitch"（音调）参数。
4. 请不要遗漏语句以及保证语句的顺序。
5. 返回结果为 JSON 格式。


### 声音配置
${JSON.stringify(voiceList, null, 2)}

### 参数说明
- name: 声音配置中的 Name 字段，区分旁白和角色。
- rate: 语速调整，百分比形式，默认 +0%（正常），如 "+50%"（加快 50%），"-20%"（减慢 20%）。
- volume: 音量调整，百分比形式，默认 +0%（正常），如 "+20%"（增 20%），"-10%"（减 10%）。
- pitch: 音调调整，默认 +0Hz（正常），如 "+10Hz"（提高 10 赫兹），"-5Hz"（降低 5 赫兹）。

### 最终返回JSON格式
{
  segments: [
    {
      name: 'specific voice',
      charactor: '角色名或narration',
      rate: '语速',
      volume: '音量',
      pitch: '音调',
      text: '文本段落',
    },
  ],
}

### 待处理内容
${text}
`

const cnEnhancedTemplate = (voiceList: VoiceConfig[], text: string) => `
你是一位专业的语音合成导演。请根据以下声音配置和文字内容，为 Qwen-Audio-TTS 模型提供精细化的配音方案。

## 核心原则
1. **自然最重要**：配音应该像真实的人在说话，不要过度表演。情感标签和拟声标签是点缀，不是必需品。
2. **对话优先**：区分旁白和角色对话。旁白应平稳叙事，角色对话应符合人物性格和语境,方言特点。
3. **克制使用标签**：情感标签（[happy]、[sad]等）和富语言标签（[laughing]、[sighing]等）仅在剧情关键转折点、情绪明显变化时偶尔使用。一段普通的日常对话不应添加任何标签。
4. **领域中立**：仅根据文字内容和上下文推断场景、角色、关系、方言和表达风格，不预设医疗、小说、广告或其他领域。

## 任务
1. 将文字按场景、角色、旁白分割。
2. 根据角色的性格、对话语气，方言特点，从声音配置中推荐合适的 "Name"。
3. 为每段推荐合理的 "rate"（语速）、"volume"（音量）、"pitch"（音调）参数。
4. 为每段推荐 "instruction"（指令），用自然语言描述这段的配音风格，使用什么方言。这是控制效果的主要手段。
5. **仅在情绪变化明显或剧情转折时才在 "text" 中嵌入情感/富语言标签，日常对话不加标签。**
6. 请不要遗漏语句并保证语句的顺序。
7. 返回结果为 JSON 格式。

## 声音配置
${JSON.stringify(voiceList, null, 2)}

## 参数说明

### instruction（指令控制 — 首选控制方式）
用自然语言描述配音的整体风格、方言或情感倾向。**每段都必须有 instruction**，这是控制配音效果最自然的方式。
示例：
- 角色塑造："用温和专业的语气解释信息"、"用轻快有感染力的语气介绍产品"
- 方言控制："用湖北话表达"、"用四川话，语气豪爽"
- 风格控制："像一个说书人，娓娓道来"、"语速稍慢，每个字说清楚"
- 情绪微调："语气中带着一丝担忧"、"声音逐渐变得严肃"

### 情感标签（可选，极少使用）
仅在情绪发生显著变化时偶尔使用。日常对话不要用。
- [happy] 高兴、[sad] 悲伤、[excited] 激动、[angry] 愤怒、[surprised] 惊讶、[fearful] 恐惧
- [whispers] 悄悄话、[serious] 严肃、[calm] 平静

### 富语言标签（可选，极少使用）
仅在需要拟声效果的戏剧性时刻偶尔使用。
- [laughing] 笑声、[sighing] 叹息、[gasp] 倒吸气、[cough] 咳嗽

### 最终返回JSON格式
{
  "segments": [
    {
      "name": "声音配置中的 Name 字段",
      "charactor": "角色名或narration",
      "rate": "语速，如 +0%",
      "volume": "音量，如 +0%",
      "pitch": "音调，如 +0Hz",
      "instruction": "自然语言指令（必填！如'用温和专业的语气清晰解释，用湖北话表达'）",
      "text": "文本段落（大多数情况下就是原文，不加任何标签。仅在极少数戏剧性时刻才加标签）"
    }
  ]
}

## 待处理内容
${text}
`

const engTemplate = (voiceList: VoiceConfig[], text: string) => `
I hope you can provide optimization suggestions for text dubbing based on the following sound configuration and a paragraph of text content. Tasks include:
1. Divide the text by scene, role, and narration.
2. Recommend a suitable "Name" from the sound configuration based on the character's personality and dialogue tone.
3. Recommend reasonable "rate" (speech speed), "volume" (volume), and "pitch" (pitch) parameters for each paragraph.
4. Please do not omit text and ensure the order of text.
5. The result is returned in JSON format.

### Sound configuration
${JSON.stringify(voiceList, null, 2)}

### Parameter description
- name: Name field in the sound configuration, distinguishing between narration and role.
- rate: Speech speed adjustment, percentage form, default +0% (normal), such as "+50%" (50% faster), "-20%" (20% slower).
- volume: Volume adjustment, percentage form, default +0% (normal), such as "+20%" (increase 20%), "-10%" (decrease 10%).
- pitch: pitch adjustment, default +0Hz (normal), such as "+10Hz" (increase 10 Hz), "-5Hz" (decrease 5 Hz).

### Final Output JSON format
{
  segments: [
    {
      name: 'specific voice',
      charactor: '角色名或narration',
      rate: '语速',
      volume: '音量',
      pitch: '音调',
      text: '文本段落',
    },
  ],
}


### Content to be processed
${text}
`
export function getPrompt(
  lang = 'cn',
  voiceList: VoiceConfig[],
  text: string,
  engine?: string
) {
  // For non-default engines, voices don't have language prefixes — use all voices.
  const isDefaultEngine = !engine || engine === 'edge-tts'
  // Qwen-Audio-TTS supports instruction control, emotion tags, rich language tags, and dialects
  const isQwenAudio = engine === 'qwen-audio-tts'
  const filteredVoices = isDefaultEngine
    ? voiceList.filter((voice) => voice.Name.startsWith(lang === 'eng' ? 'en' : 'zh'))
    : voiceList

  switch (lang) {
    case 'zh':
    case 'cn':
      return isQwenAudio
        ? cnEnhancedTemplate(filteredVoices, text)
        : cnTemplate(filteredVoices, text)
    case 'eng':
      return engTemplate(filteredVoices, text)
    default:
      throw new Error(`Unsupported language: ${lang}`)
  }
}
