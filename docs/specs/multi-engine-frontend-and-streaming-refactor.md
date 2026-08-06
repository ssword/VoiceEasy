# Spec: Multi-Engine TTS — Frontend Engine Selector & Streaming Pipeline Refactor

## Problem Statement

EasyVoice users are locked into a single TTS engine (EdgeTTS). When CosyVoice, OpenAI TTS, or Kokoro are registered on the backend, there is no way to select them from the UI, nor does the streaming pipeline know how to route synthesis to the chosen engine. Users who configured CosyVoice are forced to use EdgeTTS because the system always defaults to it — regardless of which engines are actually available.

## Solution

Add an **engine selector** to the frontend that lists all registered engines and refreshes the voice list when a different engine is picked. On the backend, refactor the streaming synthesis pipeline so that both stream and non-stream modes delegate to the selected engine through the `TtsPluginManager`, instead of hardcoding EdgeTTS calls. The CosyVoice engine (already implemented) slots into this machinery without further protocol work.

## User Stories

1. As a self-hoster, I want to see all available TTS engines in the UI, so that I can choose between EdgeTTS, OpenAI TTS, Kokoro, and CosyVoice without editing config files.
2. As a self-hoster, I want the voice dropdown to show only the voices that belong to the engine I selected, so that I don't accidentally pick a voice name that my engine doesn't understand.
3. As a content creator, I want to use CosyVoice for Chinese audiobook generation with the same one-click flow I use for EdgeTTS, so that I get better Mandarin quality without changing my workflow.
4. As a content creator, I want the LLM-powered voice recommendation to work regardless of which engine I selected, so that the AI picks voices from the correct engine's voice set.
5. As a developer, I want the streaming pipeline to route synthesis through `TtsPluginManager.getEngine(name)` instead of calling EdgeTTS directly, so that adding a new engine never requires touching `tts.service.ts` or `tts.stream.service.ts` again.
6. As a user generating long texts via stream, I want the streaming playback to start immediately regardless of which engine I chose, so that CosyVoice streams are just as responsive as EdgeTTS streams.
7. As a self-hoster, I want CosyVoice to be opt-in via `REGISTER_COSYVOICE=true`, so that it doesn't break existing deployments that haven't configured Aliyun credentials.
8. As a user generating multi-character audio (generateJson), I want to specify a per-segment engine override, so that different characters can use different TTS engines for the best voice match.

## Implementation Decisions

### Engine parameter in API requests

The `edgeSchema` (Zod) gains an optional `engine` field, defaulting to `"edge-tts"`. Every TTS endpoint (`/generate`, `/create`, `/createStream`, `/generateJson`) accepts this field. The schema validates that the requested engine exists in `TtsPluginManager`.

### Frontend engine selector

The `AudioConfig` store gains an `engine` field. A new `<EngineSelect>` component (or a select in the existing control panel) calls `GET /api/v1/tts/engines` on mount and populates a dropdown. Changing the engine triggers a voice-list refresh: the frontend passes `?engine=cosyvoice-tts` to `GET /api/v1/tts/voiceList` (or the backend filters internally).

### Voice list endpoint becomes engine-aware

`GET /api/v1/tts/voiceList` accepts an optional `engine` query parameter. When absent, it returns EdgeTTS voices (backward compatible). When present, it returns `engine.getVoiceOptions()`. The static `voice.json` file remains the EdgeTTS default.

### `/engines` endpoint returns structured data

`GET /api/v1/tts/engines` already exists but returns only `name`, `languages`, and a `Promise<voices>`. This spec tightens the contract: the endpoint resolves the voice promises before responding, and adds a `supportsSubtitles` boolean per engine so the frontend can hide the subtitle download button for engines that don't support it (CosyVoice).

### Streaming pipeline refactored to be engine-agnostic

`generateSingleVoiceStream` in `edge-tts.service.ts` is replaced by a call through `TtsPluginManager`. The retry/timeout logic that currently lives in `edge-tts.service.ts` moves into a shared helper used by all engines. The `buildSegment` and `buildSegmentList` functions in `tts.stream.service.ts` accept an engine name parameter and delegate to `ttsPluginManager.getEngine(engine).synthesize(text, { stream: true })`.

### generateJson per-segment engine override

The `dataItemSchema` gains an optional `engine` field. When present on a segment, that segment uses the specified engine instead of the top-level default. Segments without an override use the top-level engine. The concurrency controller (MapLimitController) already handles per-task fan-out, so different segments can safely hit different engine backends in parallel.

### LLM voice recommendation engine context

The prompt sent to the LLM (in `generateSegment.ts`) is injected with the list of voices from the selected engine, not just EdgeTTS voices. The `voiceList.json` remains the EdgeTTS default; other engines' voices are fetched live from `engine.getVoiceOptions()` and appended to the prompt as the available voice set.

### No engine-specific format conversion in the pipeline

Per ADR-0001, the CosyVoice engine already handles URL download and PCM→MP3 internally. The streaming pipeline and concat logic continue to assume MP3 output from every engine. No format-awareness leaks into `tts.service.ts` or `tts.stream.service.ts`.

## Testing Decisions

### Seam

All tests hit the HTTP API. No unit tests mock `TTSEngine.synthesize()` or `TtsPluginManager` internals.

### What makes a good test

- Tests assert on HTTP status codes, response shapes, and the presence/absence of engines/voices.
- Tests do NOT assert on internal engine state, ffmpeg subprocess behavior, or SSE parsing details.
- Backend tests use a test server instance (Express `app.listen(0)`) and real `fetch`/`axios` calls.
- CosyVoice-dependent tests are skipped when `REGISTER_COSYVOICE` is not set (the test checks the `/engines` response for engine presence and skips accordingly).

### Test cases

1. `GET /api/v1/tts/engines` — returns EdgeTTS always; returns CosyVoice when `REGISTER_COSYVOICE=true`; each engine has `name`, `languages`, `voices` (resolved array), `supportsSubtitles`.
2. `GET /api/v1/tts/voiceList?engine=edge-tts` — returns the default voice list (backward compat).
3. `GET /api/v1/tts/voiceList?engine=cosyvoice-tts` — returns CosyVoice voice names when engine is registered; 400 when not registered.
4. `POST /api/v1/tts/generate` with `engine=cosyvoice-tts` — returns audio URL and SRT (SRT may be empty for CosyVoice).
5. `POST /api/v1/tts/createStream` with `engine=cosyvoice-tts` — returns streamed MP3.
6. `POST /api/v1/tts/generateJson` with mixed engine per segment — each segment uses its specified engine.

### Prior art

Existing `packages/backend/tests/tts.test.ts` imports `generateTTS` and calls it directly. The new tests follow the same pattern but go through the Express app to exercise the full middleware→controller→service path.

## Out of Scope

- **CosyVoice voice cloning / custom voices**. CosyVoice supports custom voice models, but configuration and UI for that is a separate feature.
- **Engine-specific parameter UIs**. Each engine may have unique parameters (e.g., CosyVoice `sample_rate`), but the frontend only exposes the common subset (voice, rate, pitch, volume). Engine-specific advanced params remain configurable via the JSON API only.
- **Engine fallback / failover**. If the selected engine fails, the system does not automatically fall back to another engine. This is a future reliability feature.
- **Real-time engine health checks in the UI**. The `/engines` endpoint reflects registration at startup; it does not probe engine health live.

## Further Notes

- The `edge-tts` engine name string should be defined as a constant (`DEFAULT_ENGINE = 'edge-tts'`) shared between schema defaults and service code, to avoid magic-string drift.
- The existing `EdgeTTS` class in `lib/node-edge-tts` is NOT touched by this spec — only the service layer that calls it is refactored.
- CosyVoice's SSE→PCM→MP3 pipeline (ffmpeg subprocess) is already implemented and tested manually; this spec only covers integration at the API seam.
