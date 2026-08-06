# 02 — Backend Pipeline: 流式+非流式统一走 TtsPluginManager

**What to build:** `generateSingleVoice` 和 `generateSingleVoiceStream` 不再直调 EdgeTTS，改为通过 `ttsPluginManager.getEngine(name).synthesize()` 路由。EdgeTTS 的重试/超时逻辑抽取为共享 helper（`safeRunWithRetry` 已存在，确认其可被所有引擎复用）。`buildSegment` 和 `buildSegmentList` 接受 engine 参数并透传到底层调用。EdgeTTS 用户行为完全不变。

**Blocked by:** 01 — 需要 engine 参数已通过 schema 校验并传入 controller。

**Status:** ready-for-agent

- [ ] `edge-tts.service.ts` 的 `generateSingleVoice` 改为调用 `ttsPluginManager.getEngine(engine).synthesize(text, options)`
- [ ] `edge-tts.service.ts` 的 `generateSingleVoiceStream` 改为调用 `ttsPluginManager.getEngine(engine).synthesize(text, { ...options, stream: true })`
- [ ] EdgeTTS 重试/超时逻辑确认与 `safeRunWithRetry` 兼容，EdgeTtsEngine.synthesize 内部已含超时则无需额外包装
- [ ] `tts.service.ts` 的 `buildSegment`、`buildSegmentList`、`generateWithoutLLM` 接受并透传 engine 参数
- [ ] `tts.stream.service.ts` 的 `buildSegment`、`buildSegmentList`、`generateWithoutLLMStream` 接受并透传 engine 参数
- [ ] 测试：`POST /generate` 带 `engine=cosyvoice-tts` 返回音频 URL
- [ ] 测试：`POST /createStream` 带 `engine=cosyvoice-tts` 返回流式 MP3
- [ ] 测试：不传 engine 时默认走 EdgeTTS（向后兼容）
