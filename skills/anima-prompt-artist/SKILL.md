---
name: anima-prompt-artist
description: "To generate detailed, cinematic English natural language prompts for the Anima model from brief Chinese or English descriptions. Silently matches 1-2 artist styles from a curated database of 30+ illustrators and outputs strictly formatted prompts. Use this skill when the user requests Anima prompts, artist style matching, or English prompt generation for AI illustration."
agent_created: true
---

# Anima Prompt Artist Skill


## Trigger Conditions

Load this skill when the user:
- Requests generating an Anima prompt (e.g., "生成 Anima 提示词", "anima prompt for...")
- Mentions artist style matching (e.g., "@wlop style", "Kantoku 风格")
- Provides a brief description (Chinese or English) and wants a detailed English prompt for AI illustration
- Explicitly invokes via slash command mentioning anima-prompt-artist

## Core Directive

Transform brief user descriptions into detailed, cinematic English natural language prompts optimized for the **Anima model**, with silent artist style matching.

### Output Format (Strict)

Output exactly the following structure, with no explanations or Chinese text:

```
masterpiece, best quality, score_9, score_8, highres, 2025, newest, safe, @artist_name.

[Subject & Appearance: 1-2 sentences describing character/subject appearance - hair, eyes, outfit]

[Action & Environment: 1-2 sentences describing action and setting details]

[Atmosphere & Lighting: 1 sentence describing lighting style, color palette, and mood]
```

### Rules

1. **Silent Artist Matching** - Analyze the user's description style in the background. Select 1-2 matching artists from the Artist Database (`references/artist-database.md`). Add artist tags directly to the header. Do NOT output the analysis process.

2. **Character Grounding** - When the user mentions specific characters (IP or original), explicitly describe basic appearance (hair color/style, eye color, clothing details). Never use vague descriptions like "Art of Hatsune Miku in a room."

3. **Expansion** - Expand brief prompts (e.g., "a girl") with who she is, what she wears, where she is, and how the lighting looks. Output at least 3-5 complete English sentences.

4. **No Explanations** - Output only the prompt. No Chinese text, no analysis, no titles, no Markdown code blocks.

## Workflow

1. Receive user description (Chinese or English)
2. Analyze style type, character type, atmosphere keywords in the background
3. Match 1-2 artists from `references/artist-database.md`, add to Header Tags
4. Build character appearance description (anchor known IP characters with standard appearance)
5. Expand action, environment, and details
6. Add lighting and atmosphere rendering
7. Output final prompt in strict format

## References

- **Artist Database** - Load `references/artist-database.md` for the full 30+ artist style library with category classifications
- **Output Examples** - Load `references/examples.md` for strict output format examples

## Notes

- Never output Midjourney-style prompts (`--ar`, `--v` parameters)
- Always output pure English text without Markdown formatting
- If the user's description is very brief (e.g., "a girl"), proactively fill in all missing information
- Output only one prompt per request unless the user explicitly requests multiple versions
- When the user requests modifications, output the complete modified prompt directly without explaining what was changed
