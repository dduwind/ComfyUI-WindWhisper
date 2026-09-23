# 第三方内容 / Third-party content

本目录下的**三个核心文件不是本项目的作品**，原样取自 MiniMax 官方仓库，未作任何改动：

| 文件 | 来源 |
| --- | --- |
| `SKILL.md` | [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3) · `skills/h3-prompt-writing/SKILL.md` |
| `references/base-en.txt` | 同上 · `skills/h3-prompt-writing/references/base-en.txt` |
| `references/ref-en.txt` | 同上 · `skills/h3-prompt-writing/references/ref-en.txt` |

版权归 MiniMax 所有。收录在这里是为了让节点离线可用——它们是发给模型的 system prompt 的主体。
上游仓库在收录时未提供 LICENSE 文件，因此这些文件**不适用本项目根目录的 MIT 协议**；
如果 MiniMax 方面希望移除，提个 issue 即可，我会改成运行时下载。

请以上游仓库的最新版本为准，本目录的副本可能滞后。

> 目录名和文件层级都对齐了上游原样（上游就是 `skills/h3-prompt-writing/references/`），
> 这样跟上游比对时能直接 diff。

## 本项目添加的部分

下面这些文件**不是上游内容**，是 WindWhisper 为了让它在这个插件里跑起来加的外壳：

| 文件 | 作用 |
| --- | --- |
| `WW-OUTPUT.md` | 把输出装进 WindWhisper 认的 `prompt` 围栏。**删掉它，卡片和「复制 / 存库 / 推到节点」三个按钮都不会出现。** |
| `README.md` | 本说明文件（也就是你正在读的这个） |

`WW-OUTPUT.md` 在适配层的 `inject` 里排在**最后一位** —— 模型读到的顺序是先上游那三个文件、
最后才是它。位置越靠后模型越容易服从，靠的就是这一点才压得住上游自带的格式规定。

还有一点值得记下来：上游的 `SKILL.md` 只是一层**导航**，真正的规范在那两个参考文件里。
WindWhisper 没有「让模型自己去读文件」的能力，所以这两份必须在 `inject` 里显式声明，
否则一个字节都进不了 system prompt —— 模型只能靠导航那几行硬猜。

---

The three core files in this directory are **not part of this project**. They are copied verbatim,
without modification, from [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3)
(`skills/h3-prompt-writing/`). Copyright belongs to MiniMax. They are vendored so the node works
offline, since they form the bulk of the system prompt sent to the model. The upstream repository
carried no LICENSE file at the time of copying, so these files are **not covered by this project's
MIT license**. If MiniMax would like them removed, please open an issue and they will be replaced
with a runtime download. Refer to the upstream repository for the authoritative, up-to-date version.

`WW-OUTPUT.md` and this `README.md` are WindWhisper additions, not upstream content.
`WW-OUTPUT.md` is injected **last**, so it is the final thing the model reads — that is what lets
it override the upstream output-format instructions. Note also that the upstream `SKILL.md` is only
a navigation layer: the actual specification lives in the two reference files, and WindWhisper has
no ability to read files on demand, so both must be listed explicitly in the adapter's `inject`.
