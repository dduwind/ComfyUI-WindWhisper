# 第三方内容 / Third-party content

本目录下的规则文件**不是本项目的作品**，取自 Qwen（阿里通义千问）官方
Image Prompt Enhancer 的图像编辑 system prompt，**未作任何改动**：

| 文件 | 来源 | 收录时的原文件名 |
| --- | --- | --- |
| `references/i2i-guide.txt` | Qwen Image Prompt Enhancer · 图像编辑 system prompt（v2 精简版） | `system_prompt.txt` |

版权归 Qwen 团队 / 阿里巴巴所有。收录在这里是为了让它作为 WindWhisper 的 skill
离线可用 —— 这个文件就是发给模型的 system prompt 主体。

> ⚠️ 上游**没有随附 LICENSE 文件**，因此这个文件**不适用本项目根目录的 MIT 协议**。
> 如果 Qwen 方面希望移除，提个 issue 即可，我会改成运行时拉取。

请以上游最新版本为准，本目录的副本可能滞后。

## 本项目添加的部分

下面这些文件**不是上游内容**，是 WindWhisper 为了把它做成一个 skill 加的外壳：

| 文件 | 作用 |
| --- | --- |
| `SKILL.md` | skill 入口（frontmatter + 导航）。上游没有「skill」这个概念，这个文件是本项目写的。 |
| `WW-OUTPUT.md` | 两件事：把输出从上游的 JSON 改成 WindWhisper 认的 `prompt` 围栏；以及说明**这里没有输入图像**时该怎么处理。**删掉它，卡片和三个按钮都不会出现。** |
| `README.md` | 本说明文件（也就是你正在读的这个） |

`WW-OUTPUT.md` 在适配层的 `inject` 里排在**最后一位** —— 模型读到的顺序是先读上游规则、
最后才是它。位置越靠后模型越容易服从，靠的就是这一点才压得住上游的 JSON 输出要求。

## ⚠️ 一个必须记住的前提差异

上游的整套规则建立在「**总会有一张输入图**」之上（`An input image is ALWAYS present`）。
WindWhisper 是**纯文本**的提示词搭子，没有图像输入 —— 所以这份 skill 在这里的用法是
「把用户文字里的图像描述当事实、不编造没提到的细节」。这条差异写在 `WW-OUTPUT.md`
第一节，改动或精简时**别把那一节删掉**。

---

The rule file in this directory is **not part of this project**. It is taken verbatim from Qwen's
(Aliyun) official Image Prompt Enhancer system prompt for image editing.

Copyright belongs to the Qwen team / Alibaba. It is vendored here so the skill works offline, since
it forms the bulk of the system prompt sent to the model. The upstream release carried no LICENSE
file, so this file is **not covered by this project's MIT license**. If Qwen would like it removed,
please open an issue and it will be replaced with a runtime fetch. Refer to the upstream source for
the authoritative, up-to-date version.

`SKILL.md`, `WW-OUTPUT.md` and this `README.md` are WindWhisper additions, not upstream content.
`WW-OUTPUT.md` is injected **last**, so it is the final thing the model reads — that is what lets it
override the upstream JSON output requirement. It also carries the note that this environment has
**no image input**, which the upstream prompt assumes is always present.
