import type { EdgeSchema } from '../schema/generate'
import { hasInterruptionControlTag } from './recommendationInterruptions'
import { DEFAULT_ENGINE, MODEL_NAME } from '../config'

type TtsRequestBody = Pick<EdgeSchema, 'text' | 'voice'> &
  Partial<
    Pick<
      EdgeSchema,
      | 'pitch'
      | 'volume'
      | 'rate'
      | 'useLLM'
      | 'engine'
      | 'instruction'
      | 'enableTimelineControls'
      | 'enableInterruptions'
    >
  > & {
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
  enableTimelineControls,
  enableInterruptions: legacyEnableInterruptions,
}: TtsRequestBody) {
  const timelineControlsEnabled = enableTimelineControls ?? legacyEnableInterruptions ?? false

  return {
    text: text.trim(),
    pitch: normalizeAdjustment(pitch, 'Hz'),
    voice,
    rate: normalizeAdjustment(rate, '%'),
    volume: normalizeAdjustment(volume, '%'),
    useLLM: useLLM ?? false,
    enableTimelineControls: timelineControlsEnabled,
    enableInterruptions:
      useLLM === true &&
      (timelineControlsEnabled || hasInterruptionControlTag(text)),
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
