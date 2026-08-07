# Qwen-Audio-TTS Voice data

The spreadsheets in this directory and `qwen-audio-tts-clone-voices.json` are reference inputs for
Voice-cloning research and future tooling. Their entries are not system Voices that can be sent
directly to the DashScope synthesis endpoint.

Runtime Voice discovery intentionally uses the small, model-specific system Voice lists defined in
`packages/backend/src/tts/engines/qwenAudioTts.ts`. Keeping the clone-only dataset outside `src`
prevents the backend build from packaging or accidentally exposing it through `/voiceList`.
