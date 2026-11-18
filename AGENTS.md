# Agent Guidance

## Project
- This is a bilingual Spanish and English Hugo blog using the PaperMod theme with custom layouts and SCSS.
- Spanish content lives in `content/es`; English content lives in `content/en`.
- Posts belong under each language's `posts` directory. Preserve language-specific URLs and use Hugo's `relLangURL`/`relURL` helpers in templates.
- Treat `public/` and `resources/_gen/` as generated output; edit their source files instead.

## Design
- Keep the site's visual direction inspired by GitHub's Primer interface: compact dark top bars, neutral surfaces, subtle borders, blue links, and a clear active-tab indicator.
- Reuse the same brand header and profile tabs on the home page, article list, About page, and individual posts; mark the current section as active.
- Use sans-serif typography for interface and article prose, reserving monospace for code and compact technical metadata.
- Keep dark mode as the default while preserving the theme toggle and saved user preference; maintain readable light mode as well.
- Maintain responsive layouts, keyboard access, and visible focus states.
- Prefer flat layouts and restrained corner radii over decorative gradients, oversized hero sections, or nested cards.

## Validation
- Run `hugo` from the repository root after changing templates, content, or styles.
- Keep changes focused and preserve existing content and integrations unless the task requires otherwise.