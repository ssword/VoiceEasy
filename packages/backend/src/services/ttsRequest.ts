import type { EdgeSchema } from '../schema/generate'
import { DEFAULT_ENGINE, MODEL_NAME } from '../config'

type TtsRequestBody = Pick<EdgeSchema, 'text' | 'voice'> &
  Partial<Pick<EdgeSchema, 'pitch' | 'volume' | 'rate' | 'useLLM' | 'engine' | 'instruction'>> & {
    openaiModel?: string
  }

export function normalizeTtsRequest({
  text,
  pitch,
  voice,
  volume,
  rate,
  useLLM,
  engine,
  instruction,
  openaiModel,
}: TtsRequestBody) {
  return {
    text: text.trim(),
    pitch: normalizeAdjustment(pitch, 'Hz'),
    voice,
    rate: normalizeAdjustment(rate, '%'),
    volume: normalizeAdjustment(volume, '%'),
    useLLM: useLLM ?? false,
    engine: engine || DEFAULT_ENGINE,
    instruction: instruction || '',
    recommendationModel: useLLM ? openaiModel || MODEL_NAME || '' : '',
  }
}

function normalizeAdjustment(value: string | undefined, suffix: '%' | 'Hz') {
  if (value === undefined || value === '' || value === '0' || value === `0${suffix}`) {
    return `+0${suffix}`
  }
  return value
}
