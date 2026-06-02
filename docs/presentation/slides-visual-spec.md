# Visual slide spec — for AI image generation

This is the **image-ready** version of the deck: each slide reduced to a short title, minimal on-slide words, and a visual concept. The generator ([`generate-slides.mjs`](generate-slides.mjs)) turns each entry into a 1536×1024 PNG with `gpt-image-1`.

**Shared visual style** (applied to every slide): professional tech-conference slide, 3:2 landscape, dark theme — deep charcoal-navy background (#10131c). Accent = a warm coral-orange starburst/sunburst mark (the product logo motif) plus soft indigo-purple (#7c6cf0) highlights. Clean modern sans-serif, generous whitespace, flat minimal vector illustration, subtle dotted grid, high-contrast white text.

> ⚠️ Text rendering by image models is approximate. Treat these as **design mockups**. For the data slides (traction, web store, deploy), drop the real screenshots from [`images/`](images/) on top for the actual talk.

| # | File | On-slide text | Visual concept |
|---|---|---|---|
| 00 | `slide-00-title.png` | "Claude Code Browser" / "Point at it. Ask. Fixed." | Big coral starburst logo, side-panel silhouette beside a web page, confident hero layout |
| 01 | `slide-01-hook.png` | "The button is the wrong color." | A single web UI with one obviously off-color button, spotlight on it, lots of negative space |
| 02 | `slide-02-problem.png` | "Describing a pixel is hard." | Messy "telephone game": a screenshot with red arrows, a pasted CSS selector, a confused chat thread |
| 03 | `slide-03-idea.png` | "What if you could just point?" | A cursor clicking an element that morphs into a chat "chip", clean and elegant |
| 04 | `slide-04-demo.png` | "Demo" | Minimal section divider, large word DEMO, small play-triangle, starburst accent |
| 05 | `slide-05-what-happened.png` | "Point → Context → Fix → Reload" | Four-step horizontal flow with tiny icons (cursor, brackets, wrench, refresh) |
| 06 | `slide-06-beyond-css.png` | "It's not just CSS." / "Write → commit → deploy → verify" | A pipeline from a code block to a green "deployed to production" checkmark on a live site |
| 07 | `slide-07-architecture.png` | "Four pieces, one pipe" | Left-to-right diagram: Chrome extension → native messaging → Node host → Claude Code; a click traveling the pipe |
| 08 | `slide-08-decisions.png` | "Reuse > rebuild" | Three crossed-out items (API key, Playwright, "another AI") resolving into one green check |
| 09 | `slide-09-browse.png` | "/browse localhost:3000" | A terminal command opening a browser and auto-filling a "Sources" list, arrows showing the sync |
| 10 | `slide-10-weekend.png` | "41 commits. One Sunday." | A git-style bar chart with one giant bar towering over a few small ones, calendar motif |
| 11 | `slide-11-lessons.png` | "Stand on a platform." | Three clean stacked takeaway bars on whitespace, a figure standing on a platform/foundation |
| 12 | `slide-12-traction.png` | "~1,000 weekly users" / "+782% in 30 days · 5.0★" | A confident upward-trending line chart climbing toward 1K, star rating, growth glow |
| 13 | `slide-13-close.png` | "Stop describing your UI. Point at it." / "npx claude-code-browser install" | Bookend of the title: starburst logo, install command in a code pill, QR-code placeholder |

## Regenerating one slide

```bash
OPENAI_API_KEY=sk-... node docs/presentation/generate-slides.mjs slide-12-traction
```

Run with no argument to generate all slides.
</content>
