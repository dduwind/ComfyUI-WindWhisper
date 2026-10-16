# skills/ —— 内置 skill 目录

本目录装的是**随插件一起分发的内置 skill** —— 克隆下来就能直接用，不用自己攒。
每个子目录是一个 skill，入口必须是 `SKILL.md`。

> ⚠️ 早期版本这里写的是「本目录故意是空的，skill 请放用户目录」。那段话**已经作废** ——
> 后来的决定是收录一批通用提示词 skill 随插件分发（多数带第三方版权 —— 来源与许可情况
> **统一写在下面的《来源声明》里**），用户自己的 skill 仍然放用户目录。

## 来源声明

**除 `character-design-prompt` 是本项目自研之外，本目录收录的 skill 均来源于网络收集整理** ——
不是本项目的原创作品，**版权归各自原作者所有**。本项目只是把它们收集到一起、补上让它们
在 WindWhisper 里跑得起来的适配（`adapters/`），方便克隆插件的人开箱就有几套能用的 skill。

收录用于**学习与个人创作**，不涉及任何商业用途，也不代表原作者为本项目背书，**不对内容的
准确性、适用性作任何担保**，使用产生的后果由使用者承担。商业使用请自行联系原作者确认授权。

**如果你是某个 skill 的作者，不希望它被收录** —— 提个 Issue 说一声即可，不需要给任何理由，
我们看到就删。

### 各 skill 的来源

| skill | 来源 |
| --- | --- |
| `character-design-prompt` | **本项目自研**（v0.1 起于一份 `characterdesignpromptSKILL.pdf`，v0.2–0.4 逐条改定） |
| `photo-revival` | **待补** —— 后来加进目录的副本，来源尚未在本表登记。发布前需要补一行（见本节开头的要求） |
| `MOKEAIGC-V9` | 网络收集，收集自公开渠道。本副本可能带过本地调整，与原始发布版本不一定逐字一致 |
| `anima-prompt-artist` | 网络收集 —— Anima 模型的插画向规则与艺术家风格库 |
| `prompt-generator` | 网络收集，是**多份上游 skill 的汇编**：`references/upstream-skills/` 下是各上游副本（prompt-master、prompt-extractor、art-master、design-master、product-master、video-master、universal-learner 等），**版权各归其原作者**，本声明同样适用于它们 |
| `roger-deakins-cinematography` | 网络收集 —— 基于电影摄影师 Roger Deakins 公开作品与访谈资料的整理提炼。**影片画面、剧照等影像版权归各影片权利方** |
| `seedance-tvc-director` | 网络收集，来源指向 GitHub 上的 `nutllwhy/seedance-tvc-director` |
| `female-portrait-director` | 来源明确，**按上游 MIT 条款合法收录**（作者李岳）—— 见下方说明 |
| `h3-prompt-writing` | **MiniMax 官方**，原样取自 `MiniMax-AI/MiniMax-H3` |
| `Qwen-Image-2.1-PE-T2I`、`Qwen-Image-2.1-PE-I2I` | **Qwen（阿里）官方**，取自 Image Prompt Enhancer 的文生图 / 图像编辑 system prompt |
| `krea2-megastructure-prompts` | 用户提供（来自「俊熙Echo-海报工作流」），巨构 / 超尺度结构生图提示词，针对 Krea 2 模型。子目录自带 `README.md` 为 WorkBuddy 安装说明，**未 inject** |

### 只有这三个 skill 另带声明文件

**不是每个 skill 都摊一份声明** —— 只有下面这几处，且都是**上游原文或收录依据，不是本项目
加的模板**，**优先于本节适用**：

| 位置 | 是什么 | 为什么不能删 |
| --- | --- | --- |
| `female-portrait-director/` 的 `LICENSE`、`NOTICE.md`、`DISCLAIMER.md` | 上游自带：MIT 许可（© 2026 李岳）、作者署名与版本（V1.4）、使用边界 | **MIT 条款要求随副本保留**。署名建议：`Based on "女性人像提示词导演 Skill" by 李岳` |
| `h3-prompt-writing/`、`Qwen-Image-2.1-PE-T2I/`、`Qwen-Image-2.1-PE-I2I/` 的 `README.md` | 收录依据：写明哪些文件是上游原文、哪些是本项目加的外壳 | 这两家**上游仓库都没附 LICENSE**，所以这些内容**不适用本项目的 MIT 协议**，README 是它能在仓库里存在的凭据 |

> 其余 skill 目录里**只有 `SKILL.md` 和适配需要的内容**，没有额外声明文件 —— 声明就上面这一份。

## 目录里有什么

| skill | 分类 | 是什么 |
| --- | --- | --- |
| `MOKEAIGC-V9` | 风格 | 电影感世界观构建 |
| `anima-prompt-artist` | 插画 | Anima 模型的插画提示词（含 30+ 艺术家风格库） |
| `character-design-prompt` | 插画 | 角色设定图提示词（单角色全身 · 白底留白 + 背后场景切片）· **自研** |
| `female-portrait-director` | 人像 | 女性人像导演（按需加载架构，只注入最小可跑的三件） |
| `h3-prompt-writing` | 视频 | MiniMax H3 视频提示词 · **第三方**，见目录内 `README.md` |
| `photo-revival` | 插画 | 把真实照片重画成手绘插画（白纸大留白 + 局部重彩 + 手写小字）· **来源待补** |
| `prompt-generator` | 通用 | 万能提示词生成 |
| `Qwen-Image-2.1-PE-I2I` | 通用 | Qwen 图像编辑提示词改写 · **第三方** |
| `Qwen-Image-2.1-PE-T2I` | 通用 | Qwen 文生图提示词改写 · **第三方** |
| `roger-deakins-cinematography` | 摄影 | 迪金斯电影摄影知识库 |
| `seedance-tvc-director` | 视频 | TVC 导演 |
| `krea2-megastructure-prompts` | 插画 | 巨构 / 超尺度结构提示词（Krea 2）· 七层公式 + 场景剧本 + 风格预设 + 提示词库 |

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

内置 skill 的**正文**是只读的（面板里改不了；就算硬改了，插件一更新也就回去了）。
你自己的 skill 放这里：

```
ComfyUI/user/default/WindWhisper/skills/<skill-id>/SKILL.md
```

> 只是想改**显示名 / 分类 / 图标 / 剥离规则**这类"在风语里怎么用它"的东西？
> 那**不用**搬到这里 —— 内置 skill 也能在面板里直接「写适配」，而且不碰原文。
> 见下面《在面板里做适配》。

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

适配是纯可选的 —— 没有对应适配文件的 skill 照样能用，只是会原样注入。面板上会给它挂一个
「无适配」的徽章，提醒你"这个还没按风语的用法调过"。

## 在面板里做适配（不用复制副本）

面板 → 顶栏「Skill」→ 找到那个 skill（带「无适配」徽章的）→ 卡片右下 `···`：

| 菜单项 | 改什么 | 写到哪 |
| --- | --- | --- |
| **写适配（不改 skill 原文）** | 显示名 / 描述 / 分类 / 图标 / 注入清单 / 剥离规则 / 适配说明 | 只写 `user/default/WindWhisper/adapters/<id>.json` |
| 编辑（正文 + 适配） | 上面那些 **+ SKILL.md 正文** | 只对**用户目录**里的 skill 开放 |
| 复制一份来改正文 | 连正文一起复制成新 skill | 平时别用 —— 副本正文会**冻在复制那一天** |

**给内置 / 第三方 skill 做适配，用第一条就够了**：它一个字节都不动 `SKILL.md`，
插件更新也不会把适配冲掉（适配按 id 覆盖内置那份）。所以"想改个显示名就得先复制一份"
那种绕法是不必要的，两份同名 skill 反而容易选错。

编辑器里「高级」区能填剥离规则：

- **剥离章节**：每行一个关键词，**标题里含它就整节不要**（如 `运行须知`）
- **删除行**：每行一个关键词，命中就删掉那一整行（如 `pip install`）

保存后状态栏会当场告诉你**剥掉了哪几节、多少行**，以及实际注入体积变成了多少 ——
规则填错了能立刻看出来。

> 想撤销：把那些格子清空再保存一次即可。全空的适配会被删掉，skill 回到"跟正文 / 内置走"
> 的原始状态，面板上重新出现「无适配」徽章。
