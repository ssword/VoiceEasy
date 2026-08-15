# EasyVoice

A self-hosted text-to-speech solution that converts long-form text and novels into audio with AI-powered voice recommendations, streaming playback, and multi-character dubbing.

## Language

**TTS Engine**:
A pluggable backend that synthesizes speech from text. Each engine has its own voice set, format support, and protocol.
_Avoid_: TTS service, TTS provider, speech service

**Engine Plugin**:
A concrete implementation of `TTSEngine` registered in the `TtsPluginManager`. Examples: EdgeTTS, OpenAI TTS, Kokoro, CosyVoice.
_Avoid_: Driver, adapter, connector

**Doubao TTS Engine**:
A TTS Engine backed by Volcengine's Doubao speech synthesis models. It provides Doubao-specific Voices and synthesis behavior while presenting the same Engine Plugin boundary as other TTS Engines.
_Avoid_: Volcengine provider, ByteDance adapter

**Voice / Sound**:
A named timbre or character available in a TTS engine (e.g., `zh-CN-YunxiNeural`, `alloy`). Voices are engine-specific; there is no cross-engine voice abstraction.
_Avoid_: Speaker, persona, accent

**Segment**:
A unit of text paired with TTS parameters (voice, rate, pitch, volume). The minimal unit for audio generation.
_Avoid_: Chunk, slice, fragment

**Build Segment**:
A `Segment` with all TTS parameters resolved, ready to be sent to an engine's `synthesize()`.
_Avoid_: Request, task item

**Audio Assembly**:
The boundary that turns ordered, generated Build Segment audio into one final audio output while remaining independent of Segment synthesis. Concat is its serial form.
_Avoid_: Merge, join, combine

**Timeline Control**:
An explicit relation between a Segment and its immediate predecessor that changes their placement during Audio Assembly.
_Avoid_: Audio effect, punctuation, transition

**Interruption**:
A Timeline Control that starts the current Segment before its predecessor ends, with an attenuation envelope on the predecessor.
_Avoid_: Crossfade, overlap

**Pause**:
A Timeline Control that inserts a specified interval of silence before the current Segment begins.
_Avoid_: Natural pause, punctuation pause

**Timeline Mix**:
An Audio Assembly mode that resolves Timeline Controls into one ordered audio timeline.
_Avoid_: Crossfade, engine mixing

**LLM Recommendation**:
Using an LLM to analyze text and automatically assign voices and parameters to segments, replacing manual voice selection.
_Avoid_: AI配音, auto-dubbing, smart voice

**Streaming**:
Returning audio data progressively to the client as it is generated, rather than waiting for the full audio to complete. An Engine Plugin may only use this term when its upstream protocol can provide progressive audio; a non-streaming upstream response is not treated as Streaming merely because it is wrapped in a Readable.
_Avoid_: Progressive download, chunked response

**Concat**:
Merging multiple audio files (MP3) and their corresponding subtitle files (SRT) into a single output using ffmpeg.
_Avoid_: Merge, join, combine
