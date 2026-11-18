---
name: hugo-content
description: Create or edit Spanish and English articles for this Hugo blog, including front matter, taxonomy, cross-language links, and content validation.
---

# Hugo Content

- Put Spanish posts in `content/es/posts/` and English posts in `content/en/posts/`.
- Follow the front matter and taxonomy conventions of nearby posts. Preserve existing slugs and permalinks when editing published content.
- Keep technical explanations accurate, use descriptive headings, and include code examples only when they help explain the topic.
- When a translation exists, keep its meaning and structure aligned without assuming that both files share a basename.
- Run `hugo` from the repository root after content or front matter changes. Do not edit generated files under `public/`.