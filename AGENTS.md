# Agent Guidance

## Project
- This is a bilingual Spanish and English Hugo blog using the PaperMod theme with custom layouts and SCSS.
- Spanish content lives in `content/es`; English content lives in `content/en`.
- Posts belong under each language's `posts` directory. Preserve language-specific URLs and use Hugo's `relLangURL`/`relURL` helpers in templates.
- Treat `public/` and `resources/_gen/` as generated output; edit their source files instead.

## Design
- Keep the site's visual direction inspired by GitHub's Primer interface: compact navigation, clear hierarchy, neutral surfaces, subtle borders, and blue links.
- Maintain readable light and dark themes, responsive layouts, keyboard access, and visible focus states.
- Prefer flat layouts and restrained corner radii over decorative gradients, oversized hero sections, or nested cards.

## Validation
- Run `hugo` from the repository root after changing templates, content, or styles.
- Keep changes focused and preserve existing content and integrations unless the task requires otherwise.