interface Segment {
  id: string
  text: string
}

interface TTSResult {
  audio: string
  srt: string
  partial?: boolean
}

interface TTSParams {
  text: string
  voice: string
  volume: string
  rate: string
  pitch: string
  output: string
  engine?: string
  instruction?: string
  interrupt?: boolean
  overlapMs?: number
  duckPreviousDb?: number
}
type BuildSegment = TTSParams & {
  text: string
  engine?: string
  instruction?: string
}
