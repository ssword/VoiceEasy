# EasyVoice 🎙️

## 项目简介 ✨  

**EasyVoice** 是一个开源的文本、小说智能转语音解决方案，旨在帮助用户轻松将文本内容转换为高质量的语音输出。  

- **一键生成语音和字幕**

- **AI 智能推荐配音**

- **完全免费，无时长、无字数限制**

- **支持将 10 万字以上的小说一键转为有声书！**

- **流式传输，多长的文本都能立刻播放**

- **支持自定义多角色配音**

无论你是想听小说、为创作配音，还是打造个性化音频，EasyVoice 都是你的最佳助手！

**你可以轻松的将 EasyVoice 部署到你的云服务器或者本地！**

## 体验一下

[easyvoice.ioplus.tech](https://easyvoice.ioplus.tech)

## 核心功能 🌟

- **文本转语音** 📝 ➡️ 🎵  
  一键将大段文本转为语音，高效又省时。
- **流式传输** 🌊  
  再多的文本，都可以迅速返回音频直接开始试听！
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
# 开启/安装 pnpm
corepack enable
# 或者使用 npm 安装 pnpm
npm install -g pnpm

# 克隆仓库
git clone git@github.com:cosin2077/easyVoice.git
cd easyVoice
# 安装依赖
pnpm i -r

# 开发模式
pnpm dev:root

# 生产模式
pnpm build:root
pnpm start:root
```

### 3. 生成的音频、字幕保存位置

- Docker 部署： 保存在挂载的 `audio` 目录下
- Node.js 运行保存在 `./packages/backend/audio` 目录下

## 高级

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
- engine: 使用的 TTS 引擎（可选，默认 `"edge-tts"`），可选值：`"edge-tts"` / `"cosyvoice-tts"`。
- rate: 语速调整，百分比形式，默认 +0%（正常），如 "+50%"（加快 50%），"-20%"（减慢 20%）。
- volume: 音量调整，百分比形式，默认 +0%（正常），如 "+20%"（增 20%），"-10%"（减 10%）。
- pitch: 音调调整，默认 +0Hz（正常），如 "+10Hz"（提高 10 赫兹），"-5Hz"（降低 5 赫兹）。

### CosyVoice (Qwen-Audio-TTS) 引擎

CosyVoice 是阿里云百炼的 Qwen-Audio-TTS 语音合成引擎，支持流式和非流式生成，中文效果更自然。

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

### Doubao TTS 引擎

Doubao 同时支持普通生成和单向 WebSocket 流式生成。长文本仍通过 EasyVoice 的 Build Segment 流程拆分，因此不会把超出同步接口限制的整段文本直接发给上游。

在 `.env` 或 `packages/backend/.env` 中配置以下服务端变量：

```bash
REGISTER_DOUBAO_TTS=true
DOUBAO_API_KEY=your-api-key
DOUBAO_RESOURCE_ID=seed-tts-2.0
DOUBAO_MODEL=seed-audio-1.0
DOUBAO_VOICE=zh_female_tianmeitaozi_mars_bigtts
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
    "voice": "zh_female_tianmeitaozi_mars_bigtts",
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
| Doubao TTS | `REGISTER_DOUBAO_TTS=true` | 需要配置 `DOUBAO_API_KEY` 和 `DOUBAO_RESOURCE_ID` |

更多引擎接入方式参考 `packages/backend/src/tts/engines/` 目录下的实现。

## 技术实现 🛠️

- **前端**：Vue 3 + TypeScript + Element Plus 🌐  
- **后端**：Node.js + Express + TypeScript ⚡  
- **语音合成**：Microsoft EdgeTTS + 阿里云 CosyVoice (Qwen-Audio-TTS) + OpenAI TTS + Kokoro + ffmpeg 🎤  
- **部署**：Node.js + Docker + Docker Compose 🐳  

## 快速开发 🚀

1.克隆仓库

```bash
git clone https://github.com/cosin2077/easyVoice.git
```

2.安装依赖

```bash
pnpm i -r
```

3.启动项目

```bash
pnpm dev
```

4.打开浏览器，访问 `http://localhost:5173/`，开始体验吧！

## 环境变量 ⚙️

| 变量名              | 默认值                         | 描述                          |
|--------------------|-------------------------------|------------------------------|
| `PORT`             | `3000`                        | 服务端口                      |
| `OPENAI_BASE_URL`  | `https://api.openai.com/v1`   | OpenAI 兼容 API 地址          |
| `OPENAI_API_KEY`   | -                             | OpenAI API Key               |
| `MODEL_NAME`       | -                             | 使用的模型名称                 |
| `RATE_LIMIT_WINDOW`| `1`                           | 速率限制窗口大小（分钟）         |
| `RATE_LIMIT`       | `10`                          | 速率限制次数                   |
| `EDGE_API_LIMIT`   | `3`                           | Edge-TTS API 并发数           |
| `REGISTER_OPENAI_TTS` | `false`                    | 启用 OpenAI TTS 引擎          |
| `REGISTER_COSYVOICE`  | `false`                    | 启用 CosyVoice (Qwen-Audio-TTS) 引擎 |
| `DASHSCOPE_API_KEY`   | -                           | 阿里云百炼 API Key            |
| `DASHSCOPE_WORKSPACE_ID` | -                        | 阿里云百炼 Workspace ID       |
| `COSYVOICE_MODEL`  | `cosyvoice-v3-flash`         | CosyVoice 模型名称            |
| `REGISTER_DOUBAO_TTS` | `false` | 启用 Doubao 普通及流式 TTS 引擎 |
| `DOUBAO_API_KEY` | - | Doubao API Key（仅服务端使用） |
| `DOUBAO_RESOURCE_ID` | - | Doubao 音频资源 ID |
| `DOUBAO_MODEL` | `seed-audio-1.0` | Doubao 音频生成模型 |
| `DOUBAO_VOICE` | `zh_female_tianmeitaozi_mars_bigtts` | 默认 Doubao Voice |

- **配置文件**：可在 `.env` 或 `packages/backend/.env` 中设置，优先级为 `packages/backend/.env > .env`。  
- **Docker 配置**：通过 `-e` 参数传入环境变量，如上文示例。

## FAQ

- **Q: 如何配置 OpenAI 相关信息?**
- A: 在 `.env` 文件中添加 `OPENAI_API_KEY=your_api_key` `OPENAI_BASE_URL=openai_compatible_base_url` `MODEL_NAME=openai_model_name`，你可以用任何 openai compatible 的 API 地址和模型名称，例如 `https://openrouter.ai/api/v1/` 和 `deepseek`。

- **Q: 为什么我的AI配音效果不好？**
- A: AI 推荐配音是通过大模型来决定不同的段落的配音参数，大模型的能力直接影响配音结果，你可以尝试更换不同的大模型，或者是用 Edge-TTS 选择固定的声音配音。

- **Q: 速度太慢？**
- A: AI 推荐配音需要把输入的文本分段、然后让 AI 分析、推荐每一分段的配音参数，最后再生成音频、拼接。速度会比直接用 Edge-TTS慢。你可以更换相应更快的大模型，或者尝试调节 Edge-TTS 的并发参数：EDGE_API_LIMIT为更大的值(10 以下)，注意并发太高可能会有限制。

## Tips

- 当前通过 EdgeTTS API 和 CosyVoice 等多引擎提供免费/付费语音合成。

- 通过 TtsPluginManager 插件系统接入更多引擎，未来计划支持 Google TTS、声音克隆等功能。
