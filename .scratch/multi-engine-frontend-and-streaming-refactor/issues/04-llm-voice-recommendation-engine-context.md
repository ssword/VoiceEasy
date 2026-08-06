# 04 — LLM 推荐感知引擎音色

**What to build:** 当用户选中非 EdgeTTS 引擎并开启 AI 推荐配音时，LLM prompt 中的可选音色列表来自当前引擎的 `getVoiceOptions()`，而非固定的 `voiceList.json`。`voiceList.json` 仍然是 EdgeTTS 的默认音色集；其他引擎的音色从 `TtsPluginManager` 实时获取并注入 prompt。

**Blocked by:** 01 — 需要 `/voiceList?engine=` 已就绪、engine 参数已透传到 service 层。

**Status:** ready-for-agent

- [ ] `generateSegment.ts` 的 `getPrompt` 接受引擎名参数，从 `ttsPluginManager.getEngine(name).getVoiceOptions()` 获取音色列表
- [ ] `tts.service.ts` 的 `generateWithLLM` 将 engine 参数传入 `getPrompt`
- [ ] `tts.stream.service.ts` 的 `generateWithLLMStream` 将 engine 参数传入 `getPrompt`
- [ ] LLM prompt 中可选音色不超过当前引擎的实际音色范围
- [ ] 手动验证：选 CosyVoice + AI 推荐 → prompt 日志中音色列表为 CosyVoice 音色名
