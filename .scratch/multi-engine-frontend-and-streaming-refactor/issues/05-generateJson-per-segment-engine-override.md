# 05 — generateJson 逐段引擎覆盖

**What to build:** 多角色 JSON 请求 (`POST /generateJson`) 中，`data` 数组的每个 item 可指定 `engine` 字段。未指定的 segment 使用请求级默认 engine（或 `"edge-tts"`）。不同 segment 可并行使用不同引擎，`MapLimitController` 并发控制不变。最终拼接为统一 MP3。

**Blocked by:** 01, 02 — 需要 `dataItemSchema` 已有 `engine` 字段且 pipeline 已支持引擎路由。

**Status:** ready-for-agent

- [ ] `dataItemSchema` 的 `engine` 字段已由 Ticket 01 定义，确认 controller 正确提取
- [ ] `stream.controller.ts` 的 `generateJson` 透传每个 segment 的 engine 字段
- [ ] `tts.stream.service.ts` 的 `generateTTSStreamJson` 和 `buildSegmentList` 使用 segment 级 engine（回退到请求级默认）
- [ ] 不同 segment 使用不同引擎时可并行合成并正确拼接
- [ ] 测试：`POST /generateJson` 带混合 engine — 男主 EdgeTTS、女主 CosyVoice — 返回完整音频
