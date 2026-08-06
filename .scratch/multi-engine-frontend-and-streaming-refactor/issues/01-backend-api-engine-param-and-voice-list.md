# 01 — Backend API: Engine 参数 + 音色联动 + /engines 契约

**What to build:** 所有 TTS 端点接受可选的 `engine` 字段，默认 `"edge-tts"`。`/voiceList` 按 `?engine=` 查询参数过滤音色（不传时返回 EdgeTTS 音色，保持向后兼容）。`/engines` 端点返回的每个引擎对象必须 resolve 其 voice promise，并新增 `supportsSubtitles` 布尔字段。请求不存在的引擎时返回 400。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `edgeSchema` 新增 `engine` 字段，默认 `"edge-tts"`；校验 engine 名是否已注册
- [ ] 定义 `DEFAULT_ENGINE` 常量，消除 schema 和 service 中的魔法字符串
- [ ] `dataItemSchema` 新增可选 `engine` 字段
- [ ] `GET /api/v1/tts/voiceList?engine=<name>` — 按引擎过滤音色，不传时返回 EdgeTTS 默认
- [ ] `GET /api/v1/tts/engines` — 每个 engine 的 `voices` 为已 resolve 的数组；新增 `supportsSubtitles: boolean`
- [ ] 请求未注册 engine 时返回 400 + 错误消息
- [ ] `CosyVoiceTtsEngine.getVoiceOptions()` 增加 `supportsSubtitles` 能力声明
- [ ] 测试：`/engines` 在 `REGISTER_COSYVOICE=true` 时包含 CosyVoice
- [ ] 测试：`/voiceList?engine=cosyvoice-tts` 注册时返回音色列表；未注册时 400
- [ ] 测试：`/voiceList` 不传 engine 时行为不变（向后兼容）
