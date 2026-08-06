# 03 — Frontend: 引擎选择器 + 音色联动 + 字幕隐藏

**What to build:** 前端控制面板新增引擎下拉框，挂载时调用 `/engines` 获取可用引擎列表。切换引擎时自动请求 `/voiceList?engine=<name>` 刷新音色下拉框。`AudioConfig` store 持久化 `engine` 字段。引擎的 `supportsSubtitles` 为 false 时隐藏字幕下载按钮。选 CosyVoice 可完成完整的"输入文本→生成→播放"闭环。

**Blocked by:** 01, 02 — 需要后端 API 返回引擎列表、按引擎过滤音色，且 pipeline 能正确路由 synthesis 请求。

**Status:** ready-for-agent

- [ ] `AudioConfig` store 新增 `engine` 字段（默认 `"edge-tts"`），持久化
- [ ] 前端 API 层新增 `getEngines()` 调用 `GET /api/v1/tts/engines`
- [ ] `getVoiceList()` 支持传入 `engine` 参数
- [ ] 控制面板新增引擎下拉框，展示所有已注册引擎（可用引擎名作为 label）
- [ ] 切换引擎时自动重新请求音色列表并更新下拉框
- [ ] 当前选中音色在新引擎中不存在时，自动切换到新引擎的第一个音色
- [ ] `supportsSubtitles: false` 的引擎，字幕下载按钮不可见
- [ ] 生成/流式生成请求携带当前 engine 字段
- [ ] 手动测试：打开页面 → 引擎列表出现 → 选 CosyVoice → 音色变化 → 生成成功
