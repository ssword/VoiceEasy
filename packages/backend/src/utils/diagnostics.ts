import crypto from 'crypto'
import { Request, Response } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { DEFAULT_ENGINE, MODEL_NAME } from '../config'
export { safeErrorMetadata } from './safeMetadata'

export interface GenerationDiagnostics {
  startedAt: number
  audioBytes: number
  segmentCount: number
  retryCount: number
  generationMode: 'concat' | 'stream' | 'timeline-mix'
  effectiveInterruptionCount: number
  mixDurationMs: number
}

export function createGenerationDiagnostics(segmentCount = 0): GenerationDiagnostics {
  return {
    startedAt: Date.now(),
    audioBytes: 0,
    segmentCount,
    retryCount: 0,
    generationMode: 'concat',
    effectiveInterruptionCount: 0,
    mixDurationMs: 0,
  }
}

type GenerationRuntimeMetadata = Omit<GenerationDiagnostics, 'startedAt'> & {
  durationMs: number
}

export function generationRuntimeMetadata(
  diagnostics?: GenerationDiagnostics,
  overrides: Partial<GenerationRuntimeMetadata> = {}
): GenerationRuntimeMetadata {
  return {
    durationMs: diagnostics ? Date.now() - diagnostics.startedAt : 0,
    audioBytes: diagnostics?.audioBytes || 0,
    segmentCount: diagnostics?.segmentCount || 0,
    retryCount: diagnostics?.retryCount || 0,
    generationMode: diagnostics?.generationMode || 'concat',
    effectiveInterruptionCount: diagnostics?.effectiveInterruptionCount || 0,
    mixDurationMs: diagnostics?.mixDurationMs || 0,
    ...overrides,
  }
}

export function contentMetadata(text: unknown) {
  const content = typeof text === 'string' ? text : ''
  return {
    textLength: content.length,
    textHash: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
  }
}

export function ttsRequestMetadata(
  body: Record<string, unknown> | undefined,
  res?: Response,
  fallbackCorrelationId?: string
) {
  const data = Array.isArray(body?.data) ? body.data : undefined
  const engines = data
    ? Array.from(
        new Set(
          data.map((item) => {
            if (!item || typeof item !== 'object') return DEFAULT_ENGINE
            const candidate = item as Record<string, unknown>
            return typeof candidate.engine === 'string' ? candidate.engine : DEFAULT_ENGINE
          })
        )
      )
    : []
  return {
    correlationId: res?.locals?.correlationId || fallbackCorrelationId || 'unavailable',
    engine:
      engines.length > 0
        ? engines.join(',')
        : typeof body?.engine === 'string'
        ? body.engine
        : DEFAULT_ENGINE,
    model:
      typeof body?.openaiModel === 'string'
        ? body.openaiModel
        : typeof body?.recommendationModel === 'string'
        ? body.recommendationModel
        : body?.useLLM
        ? MODEL_NAME || ''
        : '',
    ...contentMetadata(body?.text),
    segmentCount: data?.length || (typeof body?.text === 'string' && body.text ? 1 : 0),
    retryCount: 0,
  }
}

export function safeRequestMetadata(req: Request) {
  return {
    correlationId: req.res?.locals?.correlationId || 'unavailable',
    method: req.method,
    ...contentMetadata(req.body?.text),
  }
}

export async function audioByteLength(audioDir: string, audioLocation: unknown): Promise<number> {
  if (typeof audioLocation !== 'string' || !audioLocation) return 0
  try {
    return (await fs.stat(path.resolve(audioDir, path.basename(audioLocation)))).size
  } catch {
    return 0
  }
}
