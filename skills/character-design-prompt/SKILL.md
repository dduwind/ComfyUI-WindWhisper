---
name: character-design-prompt
description: 根据用户描述的角色概念，生成用于 AI 绘图的角色设计图提示词，输出英文提示词、中文提示词和负面提示词三部分。当用户要求生成角色设计提示词、角色设定图提示词、character design prompt，或提到"设计一个新角色""出一版角色设定""角色三视图"时使用。
version: 0.4
updated: 2026-09-15
---

# 角色设计提示词生成器

## 描述

根据用户描述的角色概念，生成用于 AI 绘图的角色设计图提示词。输出包含英文提示词、中文提示词和负面提示词三部分。

## 触发条件

当用户要求生成角色设计提示词、角色设定图提示词、character design prompt 时触发。

也适用于这些说法：

- "设计一个新角色"
- "出一版角色设定"
- "角色三视图"

## 输出格式

> **在 WindWhisper 里**：三部分的**装法**以本 prompt 末段《WindWhisper 输出约定》为准 ——
> 英文提示词用 `prompt` 围栏、负面提示词用 `negative` 围栏，围栏外不写文字。
> 不照那段做的话，界面上的卡片和「复制 / 存库 / 推到节点」三个按钮**都不会出现**；
> 内容一个字都不用少，只是换个装法。
>
> **在别的工具里**（那段约定没跟着一起注入时）：照本节的模板原样输出。

### 固定框架

所有提示词必须包含以下固定要素：

- **角色类型**：`single character, full body, character concept art`

  注意：**不要使用 `character design sheet`**。这个词会让画图模型输出多个视图或多个姿势，本 skill 只生成单角色单姿势。

- **背景基调**：`white background, clean background`（整体干净，角色腰以下背后可带一小块场景切片，见《背景切片规则》）

- **构图**：`full body`

- **风格**：`concept art style, soft shading, highly detailed`

### 提示词结构模板

按以下顺序组织提示词内容：

1. **角色类型声明**：`single character, full body, character concept art`
2. **人物基础描述**：性别、外貌特征、发型、表情等
3. **服装/装备**：角色穿着的服装、配饰、武器等
4. **特殊设定**（仅在用户要求时添加）：如生化改造、魔法元素、科幻装备等，必须严格根据用户描述生成，不得自行添加
5. **动作姿势**：见《动作姿势规则》
6. **发散元素**：见《核心原则：分层添加》与《完整物件原则》
7. **背景切片 + 留白**：见《背景切片规则》。必须紧贴结尾，和留白描述连成一个整体单元，中间不要插入其他内容
8. **固定结尾**：`the rest of the frame clean white, concept art style, soft shading, highly detailed`

### 核心原则：分层添加

画面元素分两层处理，**判断标准是"在角色身上还是在角色之外"**。

**第一层 · 角色本体（严格按描述，不自行添加）**

- 性别、年龄、外貌、发型
- 服装、配饰、武器、装备
- 特殊设定：生化改造、魔法体质、科幻装备等
- 用户没有提到的，一律不加

**第二层 · 角色之外（允许并鼓励主动发散）**

- **物件类**：漂浮物、场景小物 —— 必须是**完整的个体**，见《完整物件原则》
- **效果类**：光效、粒子、氛围元素 —— 作为点缀，不要求完整，也不计入发散件数
- 根据角色主题发散 4-6 种，避免画面单调
- 数量不写死（画图模型对数量不敏感）

示例：用户说"魔法师在教室"

- 角色本体：只能加"魔法师"身份的标准标识（法杖、法师帽、长袍）
- 角色之外：可以发散翻开的书本、悬浮粉笔、纸飞机、发光符文、水晶碎片
  - 物件要写成完整个体：`a complete open book`、`a whole piece of chalk`、`an intact paper airplane`
  - 发光符文属于效果类，不要求完整

**如果用户只描述了基础角色**，仍然要对角色之外的画面元素做合理发散，但角色本体保持克制。

### 完整物件原则

**画面里出现的每一样"东西"都要是完整的、有可辨认外形的个体。唯一被"切割"的，只有背景切片的外边界。**

| 类别 | 是否要求完整 | 例子 |
|---|---|---|
| **物件** | 要求完整，不残缺、不被砍碎 | 课桌、书本、齿轮、海星、水晶 |
| 地表 / 痕迹 | 豁免 —— 是切片的底子，不是物件 | 木地板、瓷砖、水渍、焦痕、碎裂地面 |
| 氛围效果 | 豁免 —— 作为点缀，不计入发散件数 | 光效、星尘、火花、能量粒子 |
| 自然氛围 | 豁免 —— 小事物的集合，不逐个要求完整 | 气泡、水珠、水花、泡沫 |

写法上把"完整"显性写出来，模型更容易照做：

```
完整：one complete wooden desk, a whole seashell, an intact paper airplane
残缺：a desk edge, broken pieces of a desk, half a seashell
```

### 背景切片规则

角色背后贴**一小块场景切片**，其余保持白色留白。效果对标"游戏原画设定图，角色带局部场景"。

#### 尺寸与内容

- **尺寸**：小，大约到角色腰部。切片高度接近一张课桌的高度，比肩略宽
- **内容**：**完整物件限量 1-3 件**，外加地表纹理与氛围元素
  - 要放完整的课桌，不要只放"桌边"
  - 用数量词管尺寸（`one` / `a single` / `a pair of`），不要靠砍碎物件来缩小切片
  - 物件被砍碎会丢掉实物感，切片会退化成装饰图案
  - **地表 / 痕迹 / 氛围不受"1-3 件"限制**：沙滩、水渍、焦痕这类是切片的底子，不是物件
  - 主题本身没有物件时（如战斗主题），切片只由地表构成即可，不强行塞物件

#### 三条硬性要求

1. **切片边缘沿场景元素自身轮廓**
   - 海浪 → 沿海浪起伏的曲线
   - 教室 → 沿木地板拼接缝、课桌轮廓
   - 商店 → 沿建筑外墙轮廓
   - 机械 → 沿金属平台边、零件轮廓
   - 不是方形块，也不是随手切的多边形

   **只有切片的外边界是"切"的，切片内部的物件必须完整**：
   - `following the desk outline` → 桌子轮廓是切片的那条**外边界**，桌身完整地留在切片里（正确）
   - `with a desk edge` → 切片里只画一条桌边，桌子被砍碎（错误）
   - 外边界不规则是自然结果：边界跟着物件轮廓和地板缝走，形状就不可能规则

2. **切片与角色同一种绘制风格**
   - 不要照片质感、不要写实拼贴感

3. **其余部分保持白色留白**
   - 不要整张场景铺满
   - 不要单色块打底

#### 位置

角色**腰以下**的背后一片，延伸到脚下也可以。**不要求"脚下必须有地面"**。

#### 写法

用"角色处在某个空间里"的实句，不要用"背景里隐约可见"的虚句。

推荐写法：

```
a small patch of classroom floor behind her lower body, one complete wooden desk and a chair,
the fragment edges following the floor plank seams and the desk outline,
the rest of the frame clean white
```

不推荐写法：

```
a small section of wooden classroom floor and the edge of a desk visible behind her,
clean white background around the character
```

原因有三条：

1. `visible behind` 是背景口吻，权重低，提示词一长就被丢掉
2. 切片和留白被发散元素隔开，模型容易只执行后半句
3. `desk edge` 把边界当成了内容

备选写法（待实测对比）：

```
a fragment of classroom cropped along the floor plank seams and desk edge
```

`cropped` / `cut edges` 属于修图概念，不是绘画概念。模型不会拿剪刀，它只理解"画面里有什么"。

#### 主题场景元素参考

根据角色主题匹配场景切片内容。条目已标类别：**物件**要完整且限量 1-3 件，**地表/氛围**不受此限。

- **泳装/海滩主题** — 地表/氛围：浅水、沙滩、小浪花、水渍
- **教室/校园主题** — 物件：课桌、椅子 ｜ 地表/氛围：木地板
- **生化人/机械主题** — 物件：维修平台、散落的零件 ｜ 地表/氛围：金属地板
- **魔法/奇幻主题** — 地表/氛围：魔法阵地面、石砖地面、发光符文
- **日常/生活主题** — 地表/氛围：木地板、地毯、瓷砖地面
- **战斗主题** — 地表/氛围：碎裂地面、焦痕、战斗痕迹

「散落的零件」这类多件小物，每个都写成完整个体：`a few complete metal parts`。

#### 备选模式：纯白无背景

如果用户明确要求纯白无背景，则不加任何切片，并在负面提示词中启用 `no floor`。

### 发散元素参考（角色之外）

根据角色主题推荐与角色概念相关的小件元素，可以是漂浮物，也可以是场景道具。参考 4-6 种。

条目已标类别：**物件**要写成完整个体（`a complete X` / `a whole X`）；**氛围**类属于豁免，不要求完整，也不计入 4-6 种。

- **泳装/海洋主题** — 物件：海星、贝壳、海马、水母、珊瑚 ｜ 自然氛围：气泡、水珠、海浪
- **教室/校园主题** — 物件：书本、铅笔、笔记本、黑板擦、纸飞机、文具盒
- **生化人/机械主题** — 物件：齿轮、电路板、全息屏幕、机械零件 ｜ 氛围效果：能量粒子、火花
- **魔法/奇幻主题** — 物件：光球、花瓣、水晶（原条目"水晶碎片"改写为 `a small complete crystal`）｜ 图案/氛围：魔法阵、符文、星尘
- **科幻主题** — 物件：全息数据屏、无人机、能量线缆、微型芯片
- **其他主题**：根据用户描述的具体概念灵活推荐

**不要写残缺形态的物件**：`a torn book`、`cracked pieces`、`a broken half of a plate` 这类都是被砍碎的物件。

### 动作姿势规则

**核心：姿势要"正在发生"，不要"停在那"。**

呆板的六个技术原因，逐条避开：

1. **左右对称** —— 双肢做镜像动作，视觉直接判定为静止
2. **肢体与画面轴平行** —— 手臂垂直、腿垂直，画面里没有斜线
3. **正面平视** —— 镜头没有角度，缺少纵深
4. **用状态词不用动作词** —— `standing` / `raised` / `bent` 描述的是"停在那"
5. **没有次级动态** —— 头发、衣摆、道具全静止，画面没有"风"
6. **道具没被使用** —— 只是"拿着"，不是"正在用它做某事"

#### 三步推导法

**第一步 · 定角色动词**

不要问"他是什么"，要问"他最标志性的一个动作是什么"：

- 魔法师 → 施法 / 翻魔典 / 引导元素
- 剑士 → 拔剑 / 格挡 / 收刀
- 学生 → 举手抢答 / 埋头抄写 / 趴桌发呆
- 机械师 → 检修 / 焊接 / 拧螺栓

**第二步 · 定重心与朝向**

这是最关键的一步，比手的位置重要得多。

- 动作发生在哪个方向 → 身体朝那边转成三分侧
- 明确哪条腿承重，髋部往承重侧偏
- 另一条腿做虚点 / 交叉 / 抬起

**第三步 · 定次级动态**

- 头发往哪飘、衣摆袍角怎么扬
- 漂浮物被什么带动
- 道具在动作中的状态（指向哪、是否发光）

#### 六个动态母版

母版是预设的姿势骨架，只含重心、肢体走向、身体朝向、动势，不含任何角色特征。改姿势时先挑一个母版，再往里填角色细节。

1. **承重 + 虚点 + 回望**：`weight on one leg, the other toe-touching, head turned back`
2. **动作进行时**：`mid-step, one arm reaching forward`
3. **发力瞬间**：`body twisted, leaning back, arm swung down`
4. **侧身观察**：`three-quarter view, one hand resting on the prop`
5. **悬停**：`floating, feet off the ground, limbs trailing`
6. **互动引导**：`one hand extended toward the floating objects`

**母版固定为这 6 个，具体动作按角色现场推导。** 不要把动作内容写死成库——角色是无限的，预设库覆盖不全，还会让输出重复。

判断标准：数量有限的抽象结构可以预设，数量无限的具体内容应当现场推导。

#### 正反例

简单写法（不推荐）：

```
standing pose
```

逐项填写但缺少动势（仍然呆板）：

```
right hand gripping the staff planted on the ground, left hand raised at chest level, one leg straight and the other slightly bent, body slightly turned to the side
```

推荐写法：

```
caught mid-cast, body in three-quarter view, weight resting on her right leg with the hip shifted, left leg relaxed with the toe touching the floor, right arm swinging the staff forward mid-gesture, left arm pulled back beside her waist, chin lifted, hair blown to one side, robe hem fluttering outward
```

### 负面提示词规则

固定项：

```
no multiple views, no turnaround, no character sheet, no wide environment, no landscape, no gradient background, no text, no watermark, no signature
```

**范围类负面词要慎用，它们会误伤你要的小元素。** 已经踩过两次坑：

- `no floor` → 把你要的地面切片一起删掉
- `no full room interior` → 把你要的课桌一起删掉（课桌属于"室内"）

规律：**你要求什么，就不要在负面词里禁止它所属的大类。** 负面词只用来排除"完全不要的物体类别"，不要用它表达"限制范围"——限制范围靠正面描述里的数量词和尺寸词完成。

原稿的 `no floor` 默认不启用，仅在"纯白无背景"模式下加回。

**不要添加 `no complex background`。** 这条会连带压制漂浮元素——模型分不清"背景复杂"和"画面元素多"，容易把飘着的书本和符文一起删掉。

根据角色概念添加针对性排除项：

- 不需要动漫风格：`no anime style, no cartoon style`
- 用户未要求机械元素：`no mechanical parts, no cybernetic`

视觉属性类的负面词（`no gradient`、`no soft shading`）作用有限。据观察负面词只对"物体/类别"有效，对"视觉属性"基本不生效，保留但不要依赖。

### 输出模板

英文提示词

```
[按结构模板生成的完整英文提示词]
```

中文提示词

```
[对应的中文翻译]
```

负面提示词

```
[负面提示词]
```

可以继续调整的方向

- 提供 2-3 个可替换的方案，按**姿势构图维度**分（正面站姿 / 动态跨步 / 侧后视角等）
- 每条用加粗代码格式标注可替换的关键词

### 用户信息不足时

**不要反问，直接给 2-3 个方向。**

用户只给一句话（如"画个女剑士"）时，按姿势构图维度出 2-3 个版本：

1. 正面站姿
2. 动态跨步
3. 侧后视角

每个版本都给完整的三段式输出，末尾列出可替换的关键词。

如果用户对角色本体（性别、外貌、服装）几乎没给信息，做合理假设，并在末尾标注哪些是假设的，方便用户替换。

### 完整示例

**用户输入**：画个泳装女孩

**推导过程**

- 角色动词：海边玩水 → 踩着水花往前走
- 重心：身体三分侧，右腿承重，左腿抬起溅水
- 次级动态：头发偏向一侧，泡沫绕脚踝，气泡上浮

**英文提示词**

```
single character, full body, character concept art,
young woman, wet dark hair pulled back, cheerful expression,
high-waisted two-piece swimsuit, beaded anklet,
caught mid-step in the shallow water, body in three-quarter view,
weight on her right leg with the hip shifted, left leg lifted with water splashing off the foot,
right arm swinging back mid-motion, left hand brushing wet hair off her face,
hair blown to one side, looking slightly down at the water,
a few complete seashells and small starfish floating around her, floating bubbles and water droplets,
light foam trails around her ankles,
a small patch of wet sand and shallow water behind her lower body, one complete rolling wave,
the fragment edges following the shoreline curve and the foam line,
the rest of the frame clean white,
concept art style, soft shading, highly detailed
```

**中文提示词**

```
单个人物，全身，角色概念原画，
年轻女性，深色湿发向后束起，神情愉快，
高腰两件式泳装，脚踝戴着珠子脚链，
正在浅水中跨步的一瞬，身体呈三分侧，
重心落在右腿、髋部偏移，左腿抬起、脚下溅起水花，
右臂向后摆动，左手拨开脸上的湿发，
头发偏向一侧，视线略微向下看向水面，
几只完整的贝壳和小海星在她身周漂浮，飘着的气泡和水珠，
脚踝周围有浅浅的泡沫痕迹，
她下半身背后有一小块湿沙和浅水，一道完整的浪，
切边沿着海岸线的弧度和浪花的边缘走，
画面其余部分保持干净的白色，
概念艺术风格，柔和光影，高细节
```

**负面提示词**

```
no multiple views, no turnaround, no character sheet,
no wide environment, no landscape, no gradient background,
no text, no watermark, no signature
```

**可以继续调整的方向**

- 正面站姿：`standing facing the camera, both hands on hips`
- 动态跨步（当前）：`caught mid-step`
- 侧后视角：`seen from behind at three-quarter angle, head turned back over the shoulder`

### 注意事项

- 英文提示词中各描述之间用逗号分隔，不加句号
- 中文提示词同样用逗号分隔，不加句号
- 如果用户没有指定风格偏好，默认不加 `anime style`，使用 `concept art style` 作为基础风格
- 如果用户要求特定风格（如写实、赛博朋克、奇幻等），在固定框架的风格部分追加相应关键词
- 动作姿势描述应尽量具体，避免模糊的单词描述
- 每次生成前检查：角色本体的所有元素是否都有用户描述作为依据
- 每次生成前检查：角色之外的发散元素是否达到 4-6 种，避免画面单调
- 每次生成前检查：背景切片是否占到腰部左右，是否放了 1-3 件完整物件
- 每次生成前检查：背景切片是否沿场景元素轮廓，是否紧邻留白描述
- 每次生成前检查：画面里的物件是否都是完整个体，有没有被砍碎或被画框切断的残缺物
- 每次生成前检查：负面词里有没有禁止你要的元素所属的大类
- 每次生成前检查：姿势是否避开了对称、平行、正面平视这三个静态陷阱

## 版本记录

- **0.4**（2026-09-15）：新增《完整物件原则》——画面里所有物件必须是完整个体，唯一被"切"的只有背景切片外边界；确立三类豁免（地表/痕迹、氛围效果、自然氛围）；《主题场景元素参考》与《发散元素参考》按类别重新标注；完整示例与自检清单同步改写。
- **0.3**（2026-09-15）：切片尺寸定为"腰部左右"、内容定为"完整物件限量 1-3 件"；切片句式改为"处在某空间里"的实句并紧邻留白描述；明确区分"边界"与"内容"；负面词删掉 `no full room interior`，新增"范围类负面词会误伤目标元素"的说明。
- **0.2**（2026-09-15）：重写背景规则为"白底留白 + 沿轮廓切片"；元素添加改为分层原则；新增动作姿势三步推导与 6 个动态母版；换掉 `character design sheet`；补充 YAML frontmatter 与完整示例。
- **0.1**：初稿（characterdesignpromptSKILL.pdf）
