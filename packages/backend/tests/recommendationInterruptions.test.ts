import {
  normalizeTimelineControlSegments,
  prepareTimelineControlSourceText,
} from '../src/services/recommendationInterruptions'
import { normalizeTtsRequest } from '../src/services/ttsRequest'

describe('Issue #3 — LLM Recommendation interruption contract', () => {
  it('keeps interruptions disabled when the request field is omitted', () => {
    expect(
      normalizeTtsRequest({
        text: '  A short recommendation request.  ',
        voice: 'en-US-AriaNeural',
      } as any)
    ).toEqual(expect.objectContaining({ enableInterruptions: false }))
  })

  it('treats a manual interruption tag as an explicit opt-in', () => {
    expect(
      normalizeTtsRequest({
        text: '医生：您哪里不舒服？患者：[interrupt overlap=1000 duck=-12]就是心口这一块。',
        voice: 'longanlingxin',
        useLLM: true,
      } as any)
    ).toEqual(expect.objectContaining({ enableInterruptions: true }))
  })

  it('removes interruption metadata unless the user enabled it', () => {
    const [first, second] = normalizeTimelineControlSegments(
      [
        { text: 'I was saying—', interrupt: true, overlapMs: 400, duckPreviousDb: -9 },
        { text: 'No, listen!', interrupt: true, overlapMs: 400, duckPreviousDb: -9 },
      ],
      false
    )

    const serial = { interrupt: false, overlapMs: 0, duckPreviousDb: 0 }
    expect(first).toEqual(expect.objectContaining(serial))
    expect(second).toEqual(expect.objectContaining(serial))
  })

  it('prevents the first Segment from interrupting and bounds untrusted numeric fields', () => {
    const [first, second, third, fourth] = normalizeTimelineControlSegments(
      [
        { text: 'First', interrupt: true, overlapMs: 500, duckPreviousDb: -6 },
        { text: 'Second', interrupt: true, overlapMs: 5000, duckPreviousDb: -99 },
        { text: 'Third', interrupt: true, overlapMs: Number.NaN, duckPreviousDb: Infinity },
        { text: 'Fourth', interrupt: 'yes', overlapMs: 300, duckPreviousDb: -3 },
      ],
      true
    )

    const serial = { interrupt: false, overlapMs: 0, duckPreviousDb: 0 }
    expect(first).toEqual(expect.objectContaining(serial))
    expect(second).toEqual(
      expect.objectContaining({ interrupt: true, overlapMs: 1000, duckPreviousDb: -18 })
    )
    expect(third).toEqual(expect.objectContaining(serial))
    expect(fourth).toEqual(expect.objectContaining(serial))
  })

  it('converts an EasyVoice interruption tag while preserving native Qwen tags', () => {
    const [, interruption] = normalizeTimelineControlSegments(
      [
        { text: '我只是想说——' },
        { text: '[angry][interrupt overlap=450 duck=-11]别说了，快跑！' },
      ],
      true
    )

    expect(interruption).toEqual(
      expect.objectContaining({
        text: '[angry]别说了，快跑！',
        interrupt: true,
        overlapMs: 450,
        duckPreviousDb: -11,
      })
    )
  })

  it('uses safe defaults for a short interruption tag and removes it when disabled', () => {
    const input = [{ text: 'Wait—' }, { text: '[interrupt]No!' }]

    expect(normalizeTimelineControlSegments(input, true)[1]).toEqual(
      expect.objectContaining({
        text: 'No!',
        interrupt: true,
        overlapMs: 600,
        duckPreviousDb: -8,
      })
    )
    expect(normalizeTimelineControlSegments(input, false)[1]).toEqual(
      expect.objectContaining({
        text: 'No!',
        interrupt: false,
        overlapMs: 0,
        duckPreviousDb: 0,
      })
    )
  })

  it('accepts optional units and attribute order while enforcing timeline bounds', () => {
    const [first, second] = normalizeTimelineControlSegments(
      [
        { text: '[interrupt]Opening line' },
        { text: '[interrupt duck=-99dB overlap=5000ms]Bounded interruption' },
      ],
      true
    )

    expect(first).toEqual(
      expect.objectContaining({
        text: 'Opening line',
        interrupt: false,
        overlapMs: 0,
        duckPreviousDb: 0,
      })
    )
    expect(second).toEqual(
      expect.objectContaining({
        text: 'Bounded interruption',
        interrupt: true,
        overlapMs: 1000,
        duckPreviousDb: -18,
      })
    )
  })

  it.each([
    {
      tagged:
        '医生：最近是哪里不舒服？患者：[interrupt overlap=1450 duck=-21]就是心口这一块。',
      patientText: '患者：就是心口这一块。',
    },
    {
      tagged:
        '医生：最近胃口怎么样？[interrupt overlap=1050 duck=-21]患者：好像还冇怎么变，就是这段时间胃口差了一些。',
      patientText: '患者：好像还冇怎么变，就是这段时间胃口差了一些。',
    },
  ])(
    'reapplies source directive when LLM Recommendation omits it: $patientText',
    ({ tagged, patientText }) => {
      const source = prepareTimelineControlSourceText(tagged)
      const [doctor, patientSegment] = normalizeTimelineControlSegments(
        [
          { text: source.text.slice(0, source.text.indexOf('患者：')) },
          { text: patientText },
        ],
        true,
        source
      )

      expect(source.text).not.toContain('[interrupt')
      expect(doctor).toEqual(
        expect.objectContaining({ interrupt: false, overlapMs: 0, duckPreviousDb: 0 })
      )
      expect(patientSegment).toEqual(
        expect.objectContaining({ interrupt: true, overlapMs: 1000, duckPreviousDb: -18 })
      )
    }
  )
})

describe('Issue #15 — Timeline Control normalization contract', () => {
  it('represents serial and effective Interruption boundaries explicitly', () => {
    const [first, second, third] = normalizeTimelineControlSegments(
      [
        { text: 'First', interrupt: true, overlapMs: 500, duckPreviousDb: -6 },
        { text: 'Second', interrupt: true, overlapMs: 500, duckPreviousDb: -6 },
        { text: 'Third', interrupt: true, overlapMs: 0, duckPreviousDb: -6 },
      ],
      true
    )

    expect(first.timelineControl).toEqual({ type: 'serial' })
    expect(second.timelineControl).toEqual({
      type: 'interruption',
      overlapMs: 500,
      duckPreviousDb: -6,
    })
    expect(third.timelineControl).toEqual({ type: 'serial' })
  })

  it('maps a source Interruption directive to its recommended Segment without changing native tags', () => {
    const source = prepareTimelineControlSourceText(
      'Narrator: The storm was coming. Hero: [interrupt overlap=450 duck=-11][angry]Run!'
    )
    const [, hero] = normalizeTimelineControlSegments(
      [
        { text: 'Narrator: The storm was coming.' },
        { text: 'Hero: [angry]Run!' },
      ],
      true,
      source
    )

    expect(source.text).not.toContain('[interrupt')
    expect(hero).toEqual(
      expect.objectContaining({
        text: 'Hero: [angry]Run!',
        timelineControl: {
          type: 'interruption',
          overlapMs: 450,
          duckPreviousDb: -11,
        },
      })
    )
  })

  it.each([
    [
      'duplicate source directives',
      [{ text: 'First' }, { text: 'Second' }],
      prepareTimelineControlSourceText('First [interrupt][interrupt]Second'),
    ],
    [
      'conflicting canonical and legacy controls',
      [
        { text: 'First' },
        {
          text: 'Second',
          interrupt: true,
          overlapMs: 400,
          duckPreviousDb: -8,
          timelineControl: { type: 'serial' },
        },
      ],
      undefined,
    ],
    [
      'a source tag and LLM Interruption metadata',
      [
        { text: 'First' },
        { text: '[interrupt overlap=450 duck=-11]Second', interrupt: true, overlapMs: 300 },
      ],
      undefined,
    ],
    [
      'canonical Interruption and an explicit legacy serial relation',
      [
        { text: 'First' },
        {
          text: 'Second',
          interrupt: false,
          timelineControl: { type: 'interruption', overlapMs: 400, duckPreviousDb: -8 },
        },
      ],
      undefined,
    ],
  ])('rejects %s instead of silently selecting a Timeline Control', (_caseName, segments, source) => {
    expect(() => normalizeTimelineControlSegments(segments, true, source)).toThrow(
      /Timeline Control.*(?:duplicate|conflict)/i
    )
  })
})
