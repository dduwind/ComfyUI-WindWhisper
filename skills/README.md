# skills/ —— 内置 skill 目录

本目录装的是**随插件一起分发的内置 skill** —— 克隆下来就能直接用，不用自己攒。
每个子目录是一个 skill，入口必须是 `SKILL.md`。

> ⚠️ 早期版本这里写的是「本目录故意是空的，skill 请放用户目录」。那段话**已经作废** ——
> 后来的决定是收录一批通用提示词 skill 随插件分发（多数带第三方版权，各自的
> `README.md` 里都写明了来源和许可情况），用户自己的 skill 仍然放用户目录。

## 来源声明

**本目录收录的 skill 均来源于网络收集整理**，不是本项目的原创作品，**版权归各自原作者所有**。
本项目只是把它们收集到一起、补上让它们在 WindWhisper 里跑得起来的适配（`adapters/`），
方便克隆插件的人开箱就有几套能用的提示词 skill。收录用于学习与个人创作，
**不涉及任何商业用途，也不代表原作者为本项目背书**。

每个 skill 目录里都有一份来源说明：

| 文件 | 什么时候有 |
| --- | --- |
| `SOURCE.md` | 统一声明：网络收集、版权归原作者、可申请移除 |
| `README.md` / `NOTICE.md` / `LICENSE` | 来源更明确的 skill 单列一份（官方仓库、作者署名、许可条款） |

**如果你是某个 skill 的作者，不希望它被收录** —— 提个 Issue 说一声即可，
不需要给任何理由，我们看到就删。

> 本目录这 9 个 skill **全部**属于网络收集。标了「第三方」的那些，只是表示**另有**一份
> 独立的版权说明文件（`README.md` / `NOTICE.md`），并不代表其余几个是原创。

## 目录里有什么

| skill | 分类 | 是什么 |
| --- | --- | --- |
| `MOKEAIGC-V9` | 风格 | 电影感世界观构建 |
| `anima-prompt-artist` | 插画 | Anima 模型的插画提示词（含 30+ 艺术家风格库） |
| `female-portrait-director` | 人像 | 女性人像导演（按需加载架构，只注入最小可跑的三件） |
| `h3-prompt-writing` | 视频 | MiniMax H3 视频提示词 · **第三方**，见目录内 `README.md` |
| `prompt-generator` | 通用 | 万能提示词生成 |
| `Qwen-Image-2.1-PE-I2I` | 通用 | Qwen 图像编辑提示词改写 · **第三方** |
| `Qwen-Image-2.1-PE-T2I` | 通用 | Qwen 文生图提示词改写 · **第三方** |
| `roger-deakins-cinematography` | 摄影 | 迪金斯电影摄影知识库 |
| `seedance-tvc-director` | 视频 | TVC 导演 |

`female-portrait-director` 和 `prompt-generator` 显示体积大，是因为原文带了大量参考文件 ——
**只有适配层 `inject` 里声明过的文件才会真正进 system prompt**，其余只是躺在磁盘上。

## 格式要求

和 WorkBuddy 的 skill 同构 —— 一个目录一个 skill，入口必须是 `SKILL.md`：

```
<skill-id>/
├── SKILL.md              ← 必须。frontmatter 至少要有 name
└── references/*.md       ← 可选，是否注入由适配层的 inject 规则决定
```

`SKILL.md` 的 frontmatter：

```yaml
---
name: 我的提示词技能
description: 一句话说明它干什么、什么时候触发
icon: film          # 可选，面板上显示的图标
category: 风格      # 可选，面板上的分类
---
```

> ⚠️ 被 `inject` 命中的文件正文会**整段作为 system prompt 发给模型**。所以：
> 别把 API key、私人笔记、客户资料写进去 —— 面板里能看到的东西，模型也能看到。

## 用户自己的 skill 放哪儿

内置目录是**只读**的（面板里改不了；就算硬改了，插件一更新也就回去了）。
自己的 skill 放这里：

```
ComfyUI/user/default/WindWhisper/skills/<skill-id>/SKILL.md
```

放这里的好处：更新插件不会覆盖你的 skill，备份 ComfyUI 用户目录时一并带走。

## 怎么把 skill 弄进去

两种方式，都不用手写文件：

1. **面板内导入**（推荐）
   打开面板 → 顶栏齿轮「Skill」→ 底部「导入文件夹」→ 填 skill 所在的目录
   → 勾选要导入的 → 确认。只读扫描 + 拷贝，**不会动你的源目录**。

   如果你的 skill 来自 WorkBuddy，目录通常是：

   ```
   C:\Users\<你的用户名>\.workbuddy\skills
   ```

2. **手动拷**
   直接把 `<skill-id>/` 整个目录拷进上面的用户目录路径，然后重开面板。

## 关于「适配层」

有些 skill 是给**能执行命令的 AI** 写的（正文里有 `pip install`、`python xx.py` 这类
操作说明），但 WindWhisper 里的模型没有命令执行能力，读了会**编造执行结果**。

插件用 `adapters/<skill-id>.json` 处理这类问题，主要干三件事：

1. **声明注入哪些文件**（`inject`）。默认只注入 `SKILL.md`。
   ⚠️ 这条的代价很容易踩：**如果某个 skill 的 `SKILL.md` 只是一层导航、真正的内容在
   `references/` 里，那它不配适配层就基本用不了** —— 模型拿到的只有导航，规范一个字节
   都进不来。凡是这种结构的，必须把参考文件显式写进 `inject`。
2. **剥掉操作说明**（`strip_sections` 按标题 / `strip_lines` 按行），只留语义规则。
3. **显示名 / 分类 / 图标**（`name` / `category` / `icon`）。

还有一条很关键：**`inject` 的数组顺序就是拼进 system prompt 的顺序**，而模型对**越靠后**
的指令越服从。所以「本项目要覆盖上游格式规定」的那份文件，永远排在数组最后一位。

内置适配在插件目录的 `adapters/`（随插件更新走，只读），你在面板里改过的写在用户目录的
`adapters/`，**用户覆盖内置**、且只覆盖你改过的那几个键 —— 这样「只改个分类」不会把内置
那套剥离规则一起抹掉。

适配是纯可选的 —— 没有对应适配文件的 skill 照样能用，只是会原样注入。
