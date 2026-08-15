## Problem Statement

EasyVoice currently has no Doubao TTS Engine. Users who have access to Volcengine's Doubao speech synthesis models cannot select those Voices in the application, use Doubao's Chinese and multilingual synthesis quality, or use its upstream Streaming protocol through EasyVoice's existing generation workflows.

## Solution

Add an opt-in Doubao TTS Engine Plugin backed by the official Volcengine API reference. The Engine supports non-streaming HTTP synthesis and single-direction Streaming synthesis, maps EasyVoice's common voice/rate/volume/pitch options to Doubao's request shape, and keeps all Volcengine authentication, response decoding and protocol details inside the Engine Plugin. The existing engine discovery, Voice List, generation, LLM Recommendation, caching and Audio Assembly workflows continue to use the common TTS Engine boundary.

## User Stories

1. As a self-hoster, I want to enable Doubao TTS with an environment switch, so that existing installations are unchanged unless I opt in.
2. As a self-hoster, I want to configure a Doubao API Key without putting credentials in the frontend, so that the credential remains server-side.
3. As a self-hoster, I want to configure the Doubao resource ID and model independently, so that I can use the model version authorized for my account.
4. As a user, I want Doubao to appear in the engine selector when it is registered, so that I can choose it from the normal generation UI.
5. As a user, I want the Voice List to show Doubao Voices rather than Voices from another engine, so that each selected Voice is valid for Doubao.
6. As a user, I want the default Doubao Voice to be configurable, so that the deployment can use an authorized Voice without editing source code.
7. As a user, I want non-streaming Doubao generation to produce the same MP3-oriented result as other engines, so that playback and Audio Assembly remain compatible.
8. As a user, I want Doubao Streaming generation to return audio progressively, so that playback can begin before the whole synthesis is complete.
9. As a user, I want rate changes to affect Doubao speech speed, so that Doubao follows the common EasyVoice rate control.
10. As a user, I want volume changes to affect Doubao loudness, so that Doubao follows the common EasyVoice volume control.
11. As a user, I want pitch changes to affect Doubao pitch, so that Doubao follows the common EasyVoice pitch control.
12. As a user, I want values outside Doubao's supported parameter ranges to be normalized safely, so that a UI value cannot create an invalid upstream request.
13. As a user, I want Doubao synthesis errors and empty audio responses to fail generation, so that invalid audio is never reported as a successful result.
14. As a user, I want a failed or interrupted Doubao Stream to terminate cleanly, so that resources are released and the task does not remain falsely successful.
15. As a user, I want long text to continue through EasyVoice's existing Segment splitting, so that Doubao's per-request text limit does not prevent long-form generation.
16. As a user, I want Doubao to work with LLM Recommendation, so that recommended Voices belong to the selected Doubao Engine.
17. As a developer, I want Doubao's protocol details hidden behind the TTS Engine contract, so that orchestration services do not branch on Volcengine response formats.
18. As a maintainer, I want Doubao audio caches isolated by engine and model/resource configuration, so that changing providers cannot return incompatible audio.
19. As a user, I want the UI to know that Doubao does not currently provide EasyVoice subtitles, so that unsupported subtitle controls are not presented as available.
20. As an operator, I want safe Doubao diagnostics such as engine, resource, status code and byte count, so that failures can be investigated without logging API keys or full source text.

## Implementation Decisions

- Register a `doubao-tts` Engine Plugin only when `REGISTER_DOUBAO_TTS` is enabled. Missing or incomplete required credentials must prevent registration with a clear configuration error.
- Use the new Volcengine API Key authentication documented in the supplied PDF: `X-Api-Key` and `X-Api-Resource-Id`. Do not implement the legacy App ID plus Access Key authentication in this feature.
- Implement non-streaming synthesis with the documented HTTP audio-generation endpoint (`POST /api/v3/tts/create`). The Engine must decode the documented Base64 audio field and reject non-success codes or zero-byte audio.
- Implement single-direction Streaming with the documented WebSocket endpoint (`wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream`). It must emit audio chunks as they arrive and complete only after the documented terminal event. Bidirectional WebSocket and asynchronous long-text task polling are excluded.
- Keep the public `TTSEngine.synthesize()` contract as `Promise<Buffer | Readable>`. Protocol framing, Base64 decoding, WebSocket/Chunked lifecycle, terminal events and upstream error translation remain inside the Doubao Engine Plugin.
- Produce MP3 at 24 kHz by default so that existing Audio Assembly remains format-independent. The Engine may accept only the common output needed by EasyVoice and must not leak PCM/WAV framing into upper layers.
- Map common options to Doubao as follows: `rate` to `speech_rate` in `[-50, 100]`, `volume` to `loudness_rate` in `[-50, 100]`, and `pitch` to `post_process.pitch` in `[-12, 12]`. Normalize or clamp values before sending the request.
- Use a configurable `DOUBAO_SPEAKER` default. Expose an initial static Voice list based on the official `ListSpeakers` schema and the documented `seed-tts-2.0` example Voice `zh_female_tianmeitaozi_mars_bigtts` (甜美桃子, female, young, `zh-cn`). Deployments may override the default Voice with an authorized ID.
- Preserve structured Voice metadata (`Name`, `Gender`, `language` and equivalent public fields) so `/engines`, `/voiceList` and LLM Recommendation can consume it consistently. Dynamic HMAC-signed `ListSpeakers` discovery is out of scope.
- Set `supportsSubtitles = false` for the initial Engine integration. Although Doubao can return word timestamps when subtitle output is enabled, the current Engine contract has no metadata channel for returning those timestamps.
- Reject text longer than Doubao's 3000-character synchronous request limit at the Engine boundary. Existing service-level Segment splitting remains responsible for long-form input; the 100,000-character asynchronous API is not included.
- Give the Engine a cache namespace containing its engine name, resource ID and model so synthesis caches cannot cross-contaminate between Doubao configurations.
- Add the new configuration values to the project's environment documentation and README without exposing secrets.

## Testing Decisions

- The highest behavioral seam is the existing Engine Plugin contract exercised through the Express TTS API. Tests should verify engine discovery, Voice List selection, generation response shape and Streaming behavior without live Volcengine credentials.
- Add deterministic transport fixtures for successful non-streaming Base64 audio, upstream non-success code, malformed response, zero-byte audio, successful Streaming chunks and terminal Streaming event, and mid-stream failure.
- Assert that request headers contain the configured API Key and resource ID while tests verify that secrets are not emitted in errors or logs.
- Assert exact request mapping for speaker, model, MP3 format, sample rate, rate, volume and pitch, including boundary clamping.
- Verify `supportsSubtitles` is false in `/engines` and that existing subtitle/Audio Assembly behavior remains unchanged for other Engine Plugins.
- Verify the static Doubao Voice List includes the documented Voice metadata and that an environment override is used as the default synthesis Voice.
- Verify text at the synchronous limit is accepted and text above it fails deterministically; verify existing Segment splitting still allows long-form generation through multiple Build Segments.
- Verify cache identity changes when Doubao resource ID or model changes, while identical requests reuse the same cache entry.
- Follow existing DashScope and TTS API protocol-test patterns. Tests must not require network access, credentials, WebSocket timing, ffmpeg, persistent audio or external LLM services.

## Out of Scope

- Legacy App ID plus Access Key authentication.
- Bidirectional WebSocket TTS.
- Asynchronous long-text submit/query tasks.
- Dynamic `ListSpeakers` API calls and HMAC signing for the Volcengine management API.
- Voice cloning, custom Voice training, Voice management and mix-speaker configuration.
- Exposing Doubao word-level timestamps through a new public Engine return type.
- Automatic engine fallback, health probing or cross-engine Voice abstraction.
- Engine-specific advanced controls beyond the common rate, volume, pitch, Voice and instruction subset.

## Further Notes

- The official PDF contains separate non-streaming HTTP, single-direction HTTP Chunked, single-direction WebSocket and bidirectional WebSocket contracts. The implementation must select and test the single-direction path for EasyVoice Streaming rather than infer Streaming from a buffered response.
- The official static Voice candidate is `zh_female_tianmeitaozi_mars_bigtts`, named 甜美桃子, with `Gender = 女`, `Age = 青年`, language `zh-cn`, and resource `seed-tts-2.0`.
- Existing uncommitted worktree changes are unrelated to this spec and must be preserved by the implementation agent.
