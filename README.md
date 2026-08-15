# EasyVoice 🎙️

## 项目简介 ✨  

**EasyVoice** 是一个开源的文本、小说智能转语音解决方案，旨在帮助用户轻松将文本内容转换为高质量的语音输出。  

- **一键生成语音和字幕**

- **AI 智能推荐配音**

- **支持本地部署，按所选语音服务的资费和额度使用**

- **支持将长篇文本拆分为多个片段生成有声内容**

- **流式传输，普通长文本可以边生成边播放**

- **支持自定义多角色配音**

无论你是想听小说、为创作配音，还是打造个性化音频，EasyVoice 都是你的最佳助手！

**你可以轻松的将 EasyVoice 部署到你的云服务器或者本地！**

## 体验一下

[easyvoice.ioplus.tech](https://easyvoice.ioplus.tech)

## 核心功能 🌟

- **文本转语音** 📝 ➡️ 🎵  
  一键将大段文本转为语音，高效又省时。
- **流式传输** 🌊  
  普通长文本可以分段返回音频；启用抢话混音时，会先完成时间线混音再返回 MP3。
- **多语言支持** 🌍  
  支持中文、英文等多种语言。  
- **字幕支持** 💬  
  自动生成字幕文件，方便视频制作和字幕翻译。  
- **角色配音** 🎭  
  提供多种声音选项，完美适配不同角色。  
- **自定义设置** ⚙️  
  可调整语速、音调等参数，打造专属语音风格。  
- **AI 推荐** 🧠  
  通过 AI 智能推荐最适合的语音配置，省心又贴心。  
- **试听功能** 🎧  
  生成前可试听效果，确保每一句都如你所愿！  

## Screenshots📸

![Home](./images/readme.home.jpg)
![Generate](./images/readme.generate.jpg)

## 快速开始 🚀

### 1. 通过 docker 运行

```bash
# 极简运行，你可以通过 -e 指定环境变量
docker run -d -p 3000:3000 -v $(pwd)/audio:/app/audio cosincox/easyvoice:latest
```

or 将仓库克隆到本地，使用 Docker Compose 一键运行！

```bash
docker-compose up -d
```

### 2. 本地运行项目（请先确保已安装 Node.js 环境，参考：[安装 Node.js](https://zhuanlan.zhihu.com/p/442215189)）

```bash
# 启用 pnpm（项目固定使用 pnpm 11）
corepack enable

# 克隆仓库
git clone git@github.com:cosin2077/easyVoice.git
cd easyVoice
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 生产模式
pnpm build
pnpm start
```

### 3. 生成的音频、字幕保存位置

- Docker 部署： 保存在挂载的 `audio` 目录下
- Node.js 运行保存在 `./packages/backend/audio` 目录下

## 高级

### AI 抢话、打断与停顿（Timeline Mix）

启用 AI 推荐时，可以让 EasyVoice 识别原文中明确的打断、抢话或急切反驳，并让后一位说话者在前一段结束前开始说话。前一段声音会在重叠区域自动降低音量，使对话更自然。

使用前需要配置 OpenAI 兼容的 API。可以使用下方的环境变量，也可以在请求体中传入对应的 `openaiBaseUrl`、`openaiKey` 和 `openaiModel`：

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your_api_key
MODEL_NAME=your_model_name
```

短文本可以使用 `/generate`。该接口返回 JSON，生成的音频和字幕地址分别位于 `data.audio` 和 `data.srt`：

```bash
curl -X POST http://localhost:3000/api/v1/tts/generate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "旁白：门缓缓打开。甲：我只是想说——乙：别说了，快跑！",
    "voice": "zh-CN-XiaoxiaoNeural",
    "useLLM": true,
    "enableTimelineControls": true
  }'
```

长文本或需要直接保存音频时，使用 `/createStream`：

```bash
curl -X POST http://localhost:3000/api/v1/tts/createStream \
  -H "Content-Type: application/json" \
  -d '{
    "text": "旁白：门缓缓打开。甲：我只是想说——乙：别说了，快跑！",
    "voice": "zh-CN-XiaoxiaoNeural",
    "useLLM": true,
    "enableTimelineControls": true
  }' \
  -o timeline-mix.mp3
```

也可以在 AI 推荐请求的原文中手动标记抢话或停顿。
标签应放在受影响文本的开头：

```text
甲：我只是想说——
[interrupt overlap=600 duck=-8]乙：别说了，快跑！
```

`[pause]` 会在当前段之前增加 700 毫秒的明确静音；也可以指定 0–300000
毫秒的时长：

```text
甲：我需要想一想。
[pause duration=1200ms]乙：好，我们慢慢来。
```

该标签可以和 Qwen 原生情感标签组合：

```text
[angry][interrupt overlap=500 duck=-14]别再说了！
```

`[angry]` 会保留并交给 Qwen 控制情绪；`[interrupt ...]` 和 `[pause ...]` 会由
EasyVoice 转换为 Timeline Mix 参数，并在发送给语音引擎前从文本中删除。简写
`[interrupt]` 默认使用 600 毫秒重叠和 -8 dB 音量衰减；简写 `[pause]` 默认增加
700 毫秒静音。Pause 与 Interruption 不能同时作用于同一段，且第一段和
`duration=0` 的 Pause 会被当作无操作。Pause 在语音引擎自然生成的边界停顿之后
额外增加静音，不会造成衰减、淡入淡出或重叠。Timeline Mix 只会在抢话交界处
保守裁剪超过约 80 毫秒的边缘静音，普通对话之间仍保留语音引擎原有的停顿；
被打断者有 100 毫秒反应时间、220 毫秒平滑降音和最长 350 毫秒尾部淡出，
抢话者使用 20 毫秒淡入。手动标签本身就是明确启用信号，因此即使没有另外设置
`enableTimelineControls: true`，EasyVoice 也会自动启用 Timeline Mix。

参数说明：

- `useLLM: true`：让 AI 对原文分段并推荐角色、声音和语音参数。
- `enableTimelineControls: true`：允许 LLM Recommendation 为原文中明确存在的打断生成
  Interruption。Pause 不会由 LLM 自动推断，只能通过手动 `[pause]` 标签添加；
  只开启此参数而不启用 `useLLM` 不会生效。
- `interrupt`、`overlapMs` 和 `duckPreviousDb` 由 AI 推荐流程或 EasyVoice
  抢话标签生成，无需作为请求字段手动传入。其中重叠时间限制为 0–1000 毫秒，
  前一段的音量衰减限制为 -18–0 dB，第一段不能打断其他段落。
  `[pause duration=<number>]` 的 `ms` 后缀可选，时长必须是 0–300000 的有限数值。
- Timeline Control 标签仅限 LLM Recommendation。有效 Pause 会移动后续字幕时间，
  不会创建空白字幕条目；没有有效 Timeline Control 时仍按普通顺序拼接。
- `/createStream` 检测到有效抢话或 Pause 时会先完成 Timeline Mix，再以 MP3 返回；
  响应头 `x-generate-tts-type` 的值为 `buffered-timeline`，因此首个音频字节会
  比普通流式模式稍晚到达。

### 角色自定义

启动服务后尝试在命令行运行下述命令：

```bash
curl -X POST http://localhost:3000/api/v1/tts/generateJson \
  -H "Content-Type: application/json" \
  -d '{
  "data": [
    {
      "desc": "徐凤年",
      "text": "你敢动他，我会穷尽一生毁掉卢家，说到做到",
      "voice": "zh-CN-YunjianNeural",
      "volume": "40%"
    },
    {
      "desc": "姜泥",
      "text": "徐凤年，你快走，你打不过的",
      "voice": "zh-CN-XiaoyiNeural"
    },
    {
      "desc": "路人甲",
      "text": "他可是堂堂棠溪剑仙，这小子真是遇到强敌了",
      "voice": "zh-CN-XiaoniNeural",
      "volume": "-20%"
    },
    {
      "desc": "路人乙",
      "text": "这小子真是不知死活，竟然敢挑战卢白撷",
      "voice": "zh-TW-HsiaoChenNeural",
      "volume": "-20%"
    },
    {
      "desc": "旁白",
      "text": "面对棠溪剑仙卢白撷的杀意，徐凤年按住剑柄蓄势待发，他将姜泥放在心尖上，话锋一句比一句犀利，威逼利诱的要求卢白撷放姜泥一条生路。卢白撷也是不撞南墙不回头的人，他与西楚有深仇大恨不得不报...",
      "voice": "zh-CN-YunxiNeural",
      "rate": "0%",
      "pitch": "0Hz",
      "volume": "0%"
    },
    {
      "desc": "旁白",
      "text": "卢白撷凝聚剑气，剑光如虹，直指姜泥。剑气快到姜泥的时候，竟然被一颗小石子打破！万千剑气瞬间消散。居然就是刚刚进入山门的青衣男子。卢白撷心中警铃大作，再次凝结千万水剑想要先下手为强，青衣男子竟然一只手就挡下了，随之飓风盘起，竟然有山呼海啸之势，众人分分被逼退。随后的打斗，青衣男子每一步都精准预测了卢白撷的动作，卢白撷心中惊骇不已。",
      "voice": "zh-CN-YunxiNeural",
      "rate": "0%",
      "pitch": "0Hz",
      "volume": "0%"
    },
    {
      "desc": "卢白撷",
      "text": "人心入局，观子无敌，棋局未央，棋子难逃。你是！？ 曹长卿！",
      "voice": "zh-CN-YunyangNeural",
      "rate": "-2%",
      "pitch": "2Hz",
      "volume": "10%"
    }
  ]
}' \
-o output.mp3

```

你将看到output.mp3文件的生成，并立即可以播放。

#### 参数说明

- text: 你需要转语音的文字。
- voice: 你需要用到的声音。EdgeTTS 声音参考：[支持的声音列表](./packages/backend/src/llm/prompt/voiceList.json)，CosyVoice 声音参考上方声音列表。
- engine: 使用的 TTS 引擎（可选，默认 `"edge-tts"`）。可选值包括 `"edge-tts"`、`"cosyvoice-tts"`、`"qwen-audio-tts"`、`"openai-tts"`、`"kokoro-tts"` 和 `"doubao-tts"`；未启用的引擎不会出现在列表中。
- rate: 语速调整，百分比形式，默认 +0%（正常），如 "+50%"（加快 50%），"-20%"（减慢 20%）。
- volume: 音量调整，百分比形式，默认 +0%（正常），如 "+20%"（增 20%），"-10%"（减 10%）。
- pitch: 音调调整，默认 +0Hz（正常），如 "+10Hz"（提高 10 赫兹），"-5Hz"（降低 5 赫兹）。

### CosyVoice 引擎

CosyVoice 是阿里云百炼提供的语音合成引擎，支持流式和非流式生成，中文效果更自然。

#### 1. 获取凭证

前往 [阿里云百炼](https://bailian.console.aliyun.com/) 开通 CosyVoice 服务，获取：
- **API Key**：在右上角头像 → API Key 管理中创建
- **Workspace ID**：在百炼控制台左上角可以找到

#### 2. 配置环境变量

```bash
# .env 或 packages/backend/.env
REGISTER_COSYVOICE=true
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxx
DASHSCOPE_WORKSPACE_ID=ws-xxxxxxxxxxxxxxxx
# 可选：模型选择，默认 cosyvoice-v3-flash
COSYVOICE_MODEL=cosyvoice-v3-flash
```

#### 3. Docker 部署配置

```bash
docker run -d -p 3000:3000 \
  -e REGISTER_COSYVOICE=true \
  -e DASHSCOPE_API_KEY=sk-xxx \
  -e DASHSCOPE_WORKSPACE_ID=ws-xxx \
  -v $(pwd)/audio:/app/audio \
  cosincox/easyvoice:latest
```

#### 4. 使用 CosyVoice 生成语音

```bash
# 非流式生成
curl -X POST http://localhost:3000/api/v1/tts/generate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "你好，欢迎使用EasyVoice语音合成服务。",
    "voice": "longxiaochun",
    "engine": "cosyvoice-tts"
  }'

# 流式生成
curl -X POST http://localhost:3000/api/v1/tts/createStream \
  -H "Content-Type: application/json" \
  -d '{
    "text": "这是一段较长的中文文本，用于测试CosyVoice的流式语音合成效果。",
    "voice": "longxiaochun",
    "engine": "cosyvoice-tts"
  }' \
  -o output.mp3

# 多角色混合引擎（CosyVoice + EdgeTTS）
curl -X POST http://localhost:3000/api/v1/tts/generateJson \
  -H "Content-Type: application/json" \
  -d '{
    "data": [
      {
        "text": "Hello, I am the narrator.",
        "voice": "en-US-AriaNeural",
        "engine": "edge-tts"
      },
      {
        "text": "你好，我是女主角龙小春。",
        "voice": "longxiaochun",
        "engine": "cosyvoice-tts"
      }
    ]
  }' \
  -o output.mp3
```

#### 5. 支持的声音列表

| 声音名称 | 描述 |
|---------|------|
| `longxiaochun` | 龙小春 — 温和女声 |
| `longyu` | 龙宇 — 沉稳男声 |
| `longchen` | 龙辰 — 阳光男声 |
| `longyue` | 龙悦 — 甜美女声 |
| `longzhe` | 龙哲 — 磁性男声 |
| `longfei` | 龙飞 — 活泼男声 |
| `longbai` | 龙白 — 清冷男声 |
| `longshu` | 龙舒 — 温柔女声 |
| `longjing` | 龙静 — 文静女声 |
| `longyi` | 龙翼 — 成熟男声 |

> **注意**：CosyVoice 目前不支持字幕（SRT）生成，`supportsSubtitles: false`。

### Qwen-Audio-TTS 引擎

Qwen-Audio-TTS 是阿里云百炼的另一种语音引擎，支持通过 `instruction` 传递情感、方言等控制指令。它默认关闭，需要与 CosyVoice 一样配置 DashScope 凭证：

```bash
REGISTER_QWEN_AUDIO_TTS=true
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxx
DASHSCOPE_WORKSPACE_ID=ws-xxxxxxxxxxxxxxxx
QWEN_AUDIO_TTS_MODEL=qwen-audio-3.0-tts-plus
```

请求中的引擎名称为 `qwen-audio-tts`。该引擎不提供 EasyVoice 字幕，接口会报告 `supportsSubtitles: false`。

### Doubao TTS 引擎

Doubao 同时支持普通生成和单向 WebSocket 流式生成。长文本仍通过 EasyVoice 的 Build Segment 流程拆分，因此不会把超出同步接口限制的整段文本直接发给上游。

在 `.env` 或 `packages/backend/.env` 中配置以下服务端变量：

```bash
REGISTER_DOUBAO_TTS=true
DOUBAO_API_KEY=your-api-key
DOUBAO_RESOURCE_ID=seed-tts-2.0
DOUBAO_MODEL=seed-tts-2.0-standard
DOUBAO_VOICE=zh_female_vv_uranus_bigtts
```

- `DOUBAO_API_KEY` 和 `DOUBAO_RESOURCE_ID` 必填；API Key 只应保存在服务端环境中，不能提交到仓库或传给浏览器。
- `DOUBAO_MODEL` 和 `DOUBAO_VOICE` 可覆盖默认模型与 Voice。
- 普通生成使用 `/api/v1/tts/generate`；流式及长文本生成使用 `/api/v1/tts/createStream`，请求中设置 `"engine": "doubao-tts"`。
- Doubao 当前返回 MP3，但不生成字幕；引擎发现接口会返回 `supportsSubtitles: false`。
- 诊断日志只保留 Engine、资源 ID、状态和音频字节数等有界元数据，不记录 API Key、授权请求头或完整原文。

示例：

```bash
curl -X POST http://localhost:3000/api/v1/tts/createStream \
  -H "Content-Type: application/json" \
  -d '{
    "text": "这是一段使用豆包引擎生成的文本。",
    "voice": "zh_female_vv_uranus_bigtts",
    "engine": "doubao-tts"
  }' \
  -o doubao.mp3
```

#### 其他引擎

项目还支持以下引擎，通过环境变量启用：

| 引擎 | 环境变量 | 说明 |
|------|---------|------|
| OpenAI TTS | `REGISTER_OPENAI_TTS=true` | 需要配置 `OPENAI_API_KEY` |
| Kokoro TTS | `REGISTER_KOKORO=true` | 需要配置 `TTS_KOKORO_URL` |
| Qwen-Audio-TTS | `REGISTER_QWEN_AUDIO_TTS=true` | 需要配置 DashScope 凭证 |
| Doubao TTS | `REGISTER_DOUBAO_TTS=true` | 需要配置 `DOUBAO_API_KEY` 和 `DOUBAO_RESOURCE_ID` |

更多引擎接入方式参考 `packages/backend/src/tts/engines/` 目录下的实现。

## 技术实现 🛠️

- **前端**：Vue 3 + TypeScript + Element Plus 🌐  
- **后端**：Node.js + Express + TypeScript ⚡  
- **语音合成**：Microsoft EdgeTTS + 阿里云 CosyVoice + Qwen-Audio-TTS + OpenAI TTS + Kokoro + Doubao + ffmpeg 🎤
- **部署**：Node.js + Docker + Docker Compose 🐳  

## 快速开发 🚀

1.克隆仓库

```bash
git clone https://github.com/cosin2077/easyVoice.git
```

2.安装依赖

```bash
pnpm install
```

3.启动项目

```bash
pnpm dev
```

4.打开浏览器，访问 `http://localhost:5173/`，开始体验吧！

运行测试：

```bash
pnpm test
```

## 环境变量 ⚙️

| 变量名              | 默认值                         | 描述                          |
|--------------------|-------------------------------|------------------------------|
| `PORT`             | `3000`                        | 服务端口                      |
| `OPENAI_BASE_URL`  | -                             | OpenAI 兼容 API 地址          |
| `OPENAI_API_KEY`   | -                             | OpenAI API Key               |
| `MODEL_NAME`       | -                             | 使用的模型名称                 |
| `OPENAI_TIMEOUT_MS` | `120000`                    | OpenAI 兼容 API 请求超时（毫秒） |
| `RATE_LIMIT_WINDOW`| `10`                          | 速率限制窗口大小（分钟）         |
| `RATE_LIMIT`       | `1000000`                     | 速率限制次数；默认基本不限制      |
| `EDGE_API_LIMIT`   | `3`                           | Edge-TTS API 并发数           |
| `DIRECT_GEN_LIMIT` | `200`                         | `/generate` 单次文本长度上限     |
| `LIMIT_TEXT_LENGTH` | `0`                          | 全局文本长度上限；`0` 表示不启用  |
| `REGISTER_OPENAI_TTS` | `false`                    | 启用 OpenAI TTS 引擎          |
| `REGISTER_KOKORO` | `false`                        | 启用 Kokoro TTS 引擎           |
| `TTS_KOKORO_URL` | `http://localhost:8880/v1`     | Kokoro OpenAI 兼容服务地址      |
| `REGISTER_COSYVOICE`  | `false`                    | 启用 CosyVoice 引擎               |
| `REGISTER_QWEN_AUDIO_TTS` | `false`                | 启用 Qwen-Audio-TTS 引擎       |
| `DASHSCOPE_API_KEY`   | -                           | 阿里云百炼 API Key            |
| `DASHSCOPE_WORKSPACE_ID` | -                        | 阿里云百炼 Workspace ID       |
| `COSYVOICE_MODEL`  | `cosyvoice-v3-flash`         | CosyVoice 模型名称            |
| `QWEN_AUDIO_TTS_MODEL` | `qwen-audio-3.0-tts-plus` | Qwen-Audio-TTS 模型名称       |
| `REGISTER_DOUBAO_TTS` | `false` | 启用 Doubao 普通及流式 TTS 引擎 |
| `DOUBAO_API_KEY` | - | Doubao API Key（仅服务端使用） |
| `DOUBAO_RESOURCE_ID` | - | Doubao 音频资源 ID |
| `DOUBAO_MODEL` | `seed-tts-2.0-standard` | Doubao 音频生成模型 |
| `DOUBAO_VOICE` | `zh_female_vv_uranus_bigtts` | 默认 Doubao Voice |

- **配置文件**：可在 `.env` 或 `packages/backend/.env` 中设置，优先级为 `packages/backend/.env > .env`。  
- **Docker 配置**：通过 `-e` 参数传入环境变量，如上文示例。

## FAQ

- **Q: 如何配置 OpenAI 相关信息?**
- A: 在 `.env` 文件中添加 `OPENAI_API_KEY=your_api_key` `OPENAI_BASE_URL=openai_compatible_base_url` `MODEL_NAME=openai_model_name`，你可以用任何 openai compatible 的 API 地址和模型名称，例如 `https://openrouter.ai/api/v1/` 和 `deepseek`。

- **Q: 为什么我的AI配音效果不好？**
- A: AI 推荐配音是通过大模型来决定不同的段落的配音参数，大模型的能力直接影响配音结果，你可以尝试更换不同的大模型，或者是用 Edge-TTS 选择固定的声音配音。

- **Q: 速度太慢？**
- A: AI 推荐配音需要把输入的文本分段、让 AI 分析并推荐每一段的配音参数，最后再生成音频和拼接，因此会比直接使用 Edge-TTS 慢。可以更换更快的模型，或适当调高 `EDGE_API_LIMIT`；并发过高可能触发上游限制。

## Tips

- 当前通过 EdgeTTS、CosyVoice、Qwen-Audio-TTS、OpenAI、Kokoro 和 Doubao 等引擎提供语音合成，实际费用取决于所选服务。

- 通过 TtsPluginManager 插件系统接入更多引擎，未来计划支持 Google TTS、声音克隆等功能。
