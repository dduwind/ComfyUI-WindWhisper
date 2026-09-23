# skills/ —— 内置 skill 目录

**本目录故意是空的。**

WindWhisper 的 skill 不属于这个插件的源码，而是从你自己的提示词工作流里带过来的。
把它们打进插件仓库既不合适（很多带第三方作者和许可证），也不好维护。

## 那 skill 放哪儿

放 ComfyUI 的用户目录，**不要放这里**：

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

## 格式要求

和 WorkBuddy 的 skill 同构 —— 一个目录一个 skill，入口必须是 `SKILL.md`：

```
<skill-id>/
├── SKILL.md              ← 必须。frontmatter 至少要有 name
└── references/*.md       ← 可选，会被适配层的 inject 规则决定是否注入
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

> ⚠️ `SKILL.md` 的正文会**整段作为 system prompt 发给模型**。所以：
> 别把 API key、私人笔记、客户资料写进去 —— 面板里能看到的东西，模型也能看到。

## 关于「适配层」

有些 skill 是给**能执行命令的 AI** 写的（正文里有 `pip install`、`python xx.py` 这类
操作说明），但 WindWhisper 里的模型没有命令执行能力，读了会**编造执行结果**。

插件用 `adapters/<skill-id>.json` 处理这类问题：按标题或按行剥掉操作说明，只留语义规则。
内置适配在插件目录的 `adapters/`，你在面板里改过的写在用户目录的 `adapters/`，
**用户覆盖内置**、且只覆盖你改过的那个键。

适配是纯可选的 —— 没有对应适配文件的 skill 照样能用，只是会原样注入。
