import { describe, expect, it } from 'vitest'
import { resolveTtsApiBaseUrl } from '@/api/tts'

describe('TTS API base URL', () => {
  it('uses the mounted backend route by default', () => {
    expect(resolveTtsApiBaseUrl()).toBe('/api/v1/tts')
  })

  it('normalizes the legacy /api configuration', () => {
    expect(resolveTtsApiBaseUrl('/api')).toBe('/api/v1/tts')
    expect(resolveTtsApiBaseUrl('https://example.test/api/')).toBe(
      'https://example.test/api/v1/tts'
    )
  })
})
