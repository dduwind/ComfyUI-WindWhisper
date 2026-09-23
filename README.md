# 🍃 ComfyUI-WindWhisper · 风语

> 带 skill 的提示词搭子 —— 边看图边聊词，聊完直接推进工作流。

ComfyUI 的提示词面板不少，但大多数是「一扇独立的窗」：聊完了、复制、关掉、回到画布、
粘进节点、再排一次队。**风语把最后那几步接上了** —— 对话里产出的提示词以卡片形式出现，
一张卡片一个「推到节点」，画布上的节点立刻就有了内容。

A prompt copilot docked inside ComfyUI. Chat with any OpenAI-compatible backend,
load your own prompt skills, and push the result straight into your workflow node.

---

## 功能

| | |
|---|---|
| **接进工作流** | 节点 `🍃 风语 · 提示词` 接住文本。推送三级兜底：画布选中的 → 上次推过的 → 弹列表让你点。**推送不触发出图**，仍要自己点 `Queue Prompt` |
| **可插拔 skill** | 一个 skill 一套人设与规则。芯片一条横滑切换，带「主 skill · 附加参考」两层。skill 从你的工作流导入，不在本仓库分发（见 [`skills/README.md`](skills/README.md)） |
| **任意后端** | llama.cpp / Ollama / LM Studio / vLLM / OpenAI / DeepSeek / 任何 OpenAI 兼容端点。本地服务**不用填 API Key** |
| **悬浮按钮 + 双形态** | 画布上一个可拖动的叶子按钮（位置记住）。**单击**开窄边栏（默认 420px，拖边缘可调宽），**双击**开居中大窗。共用同一份聊天记录 |
| **多会话并行** | 想开多少开多少，各自命名、各自记上下文，关掉还能回来 |
| **词库** | 好用的提示词存下来，按分类与关键词找，一键推回节点 |
| **显存协调** | 发消息前可选清显存（`off` / `soft` / `full` 三档），**队列忙时自动跳过**，不会掐掉正在跑的活 |
| **深浅色手动切** | 按自己的习惯锁一个，不跟着 ComfyUI 主题变 |

---

## 安装

### 方式一：ComfyUI-Manager

`Manager` → `Install Custom Nodes` → 粘本仓库地址 → 安装 → 重启 ComfyUI。

### 方式二：手动

```bash
cd <你的ComfyUI>/custom_nodes
git clone https://github.com/dduwind/ComfyUI-WindWhisper.git
```

然后**重启 ComfyUI**。（`.py` 改动只有重启才生效，刷新页面不够。）

不需要装任何额外依赖 —— 只用 ComfyUI 自带的 `aiohttp` 和标准库。

---

## 快速开始

**1. 起一个本地大模型服务**

任选一个，比如 llama.cpp：

```bash
llama-server.exe -m <你的模型>.gguf --port 8080 -c 32768
```

> 💡 提示词生成是个「要理解、要遵守格式」的活，太小的模型会不听话（比如该给一段却给九段、
> 忘了把结果包进代码围栏）。建议 14B 以上。

**2. 在面板里填地址**

点画布上的叶子按钮 → 右上角**后端状态药丸** → 有快速填地址按钮：

| 按钮 | 地址 |
|---|---|
| llama.cpp | `http://127.0.0.1:8080/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| OpenAI | `https://api.openai.com/v1` |

也可以点 `+` 存自己的地址（比如别的内网机器、别的云服务），存浏览器本地，升级插件不丢。
点「测试连接」确认通了再走。

**3. 挑一个 skill（可选）**

顶栏的 skill 芯片，或者右边齿轮「Skill」里管理。**没有 skill 也能用** —— 那时的回答就是
一个通用助手。

**4. 聊，然后推到节点**

画布上放一个 `🍃 风语 · 提示词` 节点并**选中它**，然后在面板里描述你要什么。模型把最终
提示词包在 ```` ```prompt ```` 围栏里 → 面板渲染成一张卡片 → 点卡片上的「推到节点」。

> ⚠️ 推送只是**写入文本框**，不会自动出图。回画布点 `Queue Prompt`。

---

## 面板怎么用

```
        ┌─ 顶栏：会话抽屉 · 品牌 · 后端状态 · 放大/缩回 · 主题 · 词库 · 关闭
        ├─ skill 芯片条（装不下就左右滑，滚轮也行）
        ├─ 对话区（每条消息下面都有复制图标）
        └─ 输入区（可纵向拖高）
```

- **叶子按钮**：点一下开关面板，按住能拖到顺手的位置。面板开着时它会自己让到面板左边
- **单击 / 双击**：单击用上次的形态；双击直接开居中大窗（画布大、边栏挤的时候好用）
- **拖边缘调宽**：窄边栏拖左边缘，大窗拖右下角，两个尺寸分别记
- **复制图标有讲究**：气泡下那枚复制**整条原文**（含代码围栏，不丢东西）；
  卡片上那枚只复制**纯提示词**，粘进正向提示框就能用
- **全局提示词**：设置里的「全局提示词」会追加到每次对话的 system 末尾。
  它有几个快捷开关（附一句改动说明 / 给几个备选 / 更精简），点了是把文字**写进输入框**，你还能改

---

## 节点

| | |
|---|---|
| 名字 | `🍃 风语 · 提示词` |
| 输入 | `text`（多行字符串） |
| 输出 | `STRING`（直通） |
| 分类 | `🍃 风语` |

节点本身**极简**：只接字符串。生成发生在面板里，节点不烧 token、不占显存。
`{}` 不会被当成动态提示词（`dynamicPrompts: False`），提示词原文照传。

---

## 目录结构

```
ComfyUI-WindWhisper/
├── __init__.py              插件入口（节点注册 + 路由挂载）
├── adapters/                内置 skill 的适配规则（可选，见 skills/README.md）
├── skills/                  内置 skill 目录（本仓库为空，理由见该目录的 README）
├── windwhisper/
│   ├── nodes.py             节点定义
│   ├── routes.py            25 条 /windwhisper/* 路由
│   ├── store.py             配置 + 会话持久化 + 用户目录解析
│   ├── llm.py               OpenAI 兼容客户端（流式）
│   ├── prompt.py            system 拼装 + 上下文裁剪
│   ├── skills.py            skill 扫描 + 适配 + 两级剥离
│   ├── library.py           词库
│   └── vram.py              显存协调
└── web/
    ├── windwhisper.js       主页面侧：悬浮按钮 + 面板壳 + 推送
    └── panel/               iframe 面板（子目录不会被自动加载）
```

**用户数据不在这里**，在 ComfyUI 的用户目录下 —— 所以更新插件不会冲掉你的东西：

```
ComfyUI/user/default/WindWhisper/
├── config.json              后端地址 / 模型 / 参数
├── chats/*.json             会话
├── library.json             词库
├── skills/<id>/SKILL.md     你导入的 skill
└── adapters/<id>.json       你在面板里改过的适配规则
```

---

## 常见问题

**面板打不开 / 菜单里没有「🍃 风语」**
先看 `http://127.0.0.1:8188/windwhisper/ping` 有没有正常 JSON。没有的话看 ComfyUI 启动
日志里有没有 `[WindWhisper]` 开头的报错，多半是没重启。

**回答了，但只有一个空气泡**
思考链把输出预算吃光了。模型在「想」上花掉的 token 和正文**共用同一个上限**。去设置里
**关掉「让模型先思考」**，或者把 `max_tokens` 调大。界面会明确告诉你是不是这个原因。

**给的内容不完整 / 被从中间截断**
`max_tokens` 不够。要输出长提示词的 skill（一次给好几段、带世界观设定的）尤其吃这个，
给到 8192 比较稳。

**点复制没反应**
同源 iframe 下浏览器可能拒绝写剪贴板。插件已带降级通道，真失败了会弹提示。

**推了 A 还没出图，又推了 B，会不会出两批？**
不会。推送是**覆盖写入**，而且**完全不触发执行** —— 只有你点 `Queue Prompt` 才会跑，
跑的永远是你最后推进去的那个。

**换 skill 会把聊天记录清掉吗？**
不会。skill 只是会话上的一个属性，历史会留着。

---

## 致谢

- 面板与交互设计参考了 [ComfyUI_ComfyAssistant](https://github.com/ComfyNodePRs/ComfyUI_ComfyAssistant) 的悬浮入口思路
- 词库的两栏布局参考了 ComfyUI-H3-PromptWriter 的组织方式
- 图标来自 [lucide](https://lucide.dev/)

---

## 许可

[MIT](LICENSE) —— 随便用，保留版权声明即可。

---

> ⚠️ **本仓库不含任何 skill 本体。** `skills/` 目录只有一个说明文件；
> 你导入的 skill 落在 `ComfyUI/user/default/WindWhisper/skills/`，跟着你的 ComfyUI 走。
> 理由与做法见 [`skills/README.md`](skills/README.md)。
