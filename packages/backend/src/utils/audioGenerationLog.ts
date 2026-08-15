import winston from 'winston'

const AUDIO_GENERATION_FIELDS = [
  'text',
  'voice',
  'engine',
  'rate',
  'pitch',
  'volume',
  'instruction',
  'interrupt',
  'overlapMs',
  'duckPreviousDb',
] as const

const terminalLogger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      format: winston.format.printf(({ message }) => String(message)),
    }),
  ],
})

/** Print the exact, bounded synthesis parameters without persisting source text or credentials. */
export function logAudioGenerationJson(segments: unknown[]): void {
  const safeSegments = segments.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const segment = value as Record<string, unknown>
    return Object.fromEntries(
      AUDIO_GENERATION_FIELDS.flatMap((field) =>
        segment[field] === undefined ? [] : [[field, segment[field]]]
      )
    )
  })

  terminalLogger.info(`Audio generation JSON:\n${JSON.stringify(safeSegments, null, 2)}`)
}
