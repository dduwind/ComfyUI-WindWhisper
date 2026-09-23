# Output Examples (输出示例 - Strict Reference)

These examples show the exact output format. Follow this structure strictly.

---

## Example 1: Original Character / Daily Fresh Style

**Input**: "一个短发女孩在教室吃三明治，阳光明媚，Kantoku风格"

**Output**:
```
masterpiece, best quality, score_9, score_8, highres, 2025, newest, safe, @kantoku.

A bright and cheerful anime illustration of a cute high school girl. She has short, bobbed chestnut hair and warm amber eyes. She is wearing a standard sailor-style school uniform with a pleated skirt.

The girl is sitting at her wooden desk in a sunlit classroom, happily holding and eating a fresh sandwich. The background shows a chalkboard and windows letting in brilliant beams of sunlight.

The image features soft natural lighting, a warm and vibrant color palette, and a cheerful slice-of-life atmosphere with crisp highlights.
```

---

## Example 2: IP Character / Fantasy Atmosphere Style

**Input**: "Frieren (葬送的芙莉莲) 在森林里看魔法书，魔法特效，氛围感"

**Output**:
```
masterpiece, best quality, score_9, score_8, highres, 2025, newest, safe, @rella, @arsenixc.

A breathtaking digital fantasy artwork featuring Frieren from Sousou no Frieren. She has long, flowing white twin-tails and calm green eyes, wearing her signature white capelet with gold trim, dark undershirt, and black pantyhose.

She is standing deep within an ancient, moss-covered forest, intently reading a glowing magic grimoire held in her hands. Magical particles and floating geometric rune lights surround her, illuminating the shadowed woods with soft golden and blue glows.

The image features cinematic volumetric lighting, a cool forest-green and mystical gold color palette, and a serene yet otherworldly atmosphere with intricate background details.
```

---

## Example 3: Simple Input / Auto-Expansion

**Input**: "一个女孩"

**Expected Output** (must expand with details):
```
masterpiece, best quality, score_9, score_8, highres, 2025, newest, safe, @anmi.

A soft and delicate anime illustration of a young girl with flowing silver hair and gentle violet eyes. She is wearing a simple white lace dress with a light blue ribbon at the waist.

She is standing in a blooming flower field on a warm spring day, a gentle breeze brushing through her hair. Colorful petals float around her in the soft afternoon light.

The image features warm backlighting, a pastel pink and green color palette, and a dreamy, healing atmosphere with a watercolor-like softness.
```

---

## Format Rules (格式规则)

1. Header ends with a period (`.`)
2. Body has 3-5 complete English sentences, separated into 3 paragraphs
3. No Chinese text, no explanations, no Markdown code blocks
4. `safe` tag is always included
5. Artist tags are silently selected - never explain the selection
