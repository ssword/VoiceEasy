# ADR 0001: CosyVoice engine hides URL indirection and SSE protocol internally

CosyVoice (Qwen-Audio-TTS) non-streaming responses return a 24h-valid audio download URL rather than audio bytes, and its streaming mode uses SSE-delimited base64-encoded PCM rather than raw binary. We decided the engine internally downloads the URL and transcodes PCM→MP3 so that `TTSEngine.synthesize()` remains `Promise<Buffer | Readable>` across all engines.

**Considered Options**:
- Expose URL to upper layers (tts.service) — rejected because it forces every caller to handle an engine-specific response shape.
- Only support streaming — rejected because it discards the URL's caching advantage and complicates short-text synthesis.
- Engine-internal conversion — chosen because it keeps the engine interface uniform and isolates protocol complexity.

**Consequences**:
- CosyVoice engine carries extra latency (one HTTP round-trip for URL download; ffmpeg subprocess for PCM→MP3).
- Subtitle generation is unavailable for CosyVoice because the engine does not return word-level timestamps.
