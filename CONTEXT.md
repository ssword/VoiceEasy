# EasyVoice

A self-hosted text-to-speech solution that converts long-form text and novels into audio with AI-powered voice recommendations, streaming playback, and multi-character dubbing.

## Language

**TTS Engine**:
A pluggable backend that synthesizes speech from text. Each engine has its own voice set, format support, and protocol.
_Avoid_: TTS service, TTS provider, speech service

**Engine Plugin**:
A concrete implementation of `TTSEngine` registered in the `TtsPluginManager`. Examples: EdgeTTS, OpenAI TTS, Kokoro, CosyVoice.
_Avoid_: Driver, adapter, connector

**Voice / Sound**:
A named timbre or character available in a TTS engine (e.g., `zh-CN-YunxiNeural`, `alloy`). Voices are engine-specific; there is no cross-engine voice abstraction.
_Avoid_: Speaker, persona, accent

**Segment**:
A unit of text paired with TTS parameters (voice, rate, pitch, volume). The minimal unit for audio generation.
_Avoid_: Chunk, slice, fragment

**Build Segment**:
A `Segment` with all TTS parameters resolved, ready to be sent to an engine's `synthesize()`.
_Avoid_: Request, task item

**LLM Recommendation**:
Using an LLM to analyze text and automatically assign voices and parameters to segments, replacing manual voice selection.
_Avoid_: AI配音, auto-dubbing, smart voice

**Streaming**:
Returning audio data progressively to the client as it is generated, rather than waiting for the full audio to complete.
_Avoid_: Progressive download, chunked response

**Concat**:
Merging multiple audio files (MP3) and their corresponding subtitle files (SRT) into a single output using ffmpeg.
_Avoid_: Merge, join, combine
