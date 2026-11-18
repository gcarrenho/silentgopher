---
name: hugo-interface
description: Build or adjust layouts and styles for the Silent Gopher Hugo site while preserving its GitHub-inspired visual direction and responsive behavior.
---

# Hugo Interface

- Follow the site's GitHub Primer-inspired direction: compact dark top bars, quiet neutral backgrounds, blue links, fine borders, and clear active navigation.
- Reuse the same brand header and profile tabs across home, article lists, About, and individual posts; keep the active section visible on each page.
- Use sans-serif typography for article prose and headings, reserving monospace for code and compact technical metadata.
- Keep light and dark theme tokens in `assets/scss/_theme.scss`; prefer existing shared SCSS modules over page-specific overrides.
- Keep controls keyboard-accessible, provide visible focus states, and check narrow viewports when changing layout or navigation.
- Prefer flat surfaces, restrained radii, and content-first layouts. Avoid decorative gradients and excessive card framing.
- Use Hugo URL helpers in templates and run `hugo` after template or SCSS changes.