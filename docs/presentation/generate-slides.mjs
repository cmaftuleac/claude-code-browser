#!/usr/bin/env node
// Generate presentation slides as images using OpenAI's gpt-image-1 model.
//
// Usage:
//   OPENAI_API_KEY=sk-... node docs/presentation/generate-slides.mjs            # all slides
//   OPENAI_API_KEY=sk-... node docs/presentation/generate-slides.mjs slide-12   # one slide (prefix match)
//
// Env overrides: QUALITY=low|medium|high (default medium), SIZE=1536x1024 (default).
// The key is read from the environment only — never hardcode it in this file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("✗ OPENAI_API_KEY is not set. Run: OPENAI_API_KEY=sk-... node docs/presentation/generate-slides.mjs");
  process.exit(1);
}

const MODEL = "gpt-image-1";
const SIZE = process.env.SIZE || "1536x1024"; // landscape, closest to 16:9 gpt-image-1 supports
const QUALITY = process.env.QUALITY || "medium"; // low | medium | high
const ENDPOINT = "https://api.openai.com/v1/images/generations";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "images", "generated");

// Shared art direction prepended to every prompt for a consistent deck.
const STYLE = [
  "Professional tech-conference presentation slide, 3:2 landscape, 16:9 feel.",
  "Dark theme: deep charcoal-navy background (#10131c) with a subtle dotted grid.",
  "Accent colors: a warm coral-orange starburst/sunburst mark (the product logo motif) and soft indigo-purple (#7c6cf0) highlights.",
  "Clean modern sans-serif typography, generous whitespace, flat minimal vector illustration, high-contrast white text.",
  "Render any quoted text exactly, spelled correctly, as the slide's headline. Keep text minimal and large.",
].join(" ");

const SLIDES = [
  {
    file: "slide-00-title.png",
    prompt: `Title slide. Headline text: "Claude Code Browser". Subtitle text: "Point at it. Ask. Fixed.". A large coral-orange starburst logo, and a stylized browser side-panel silhouette next to a web page. Confident hero layout.`,
  },
  {
    file: "slide-01-hook.png",
    prompt: `Hook slide. One big line of text: "The button is the wrong color." A simple web UI mockup with a single obviously off-color button highlighted by a spotlight. Lots of negative space, minimal.`,
  },
  {
    file: "slide-02-problem.png",
    prompt: `Problem slide. Headline text: "Describing a pixel is hard." Visualize a messy game of telephone between a human and an AI: a screenshot with red arrows, a pasted CSS selector code snippet, a confused chat thread. Slightly chaotic, frustration.`,
  },
  {
    file: "slide-03-idea.png",
    prompt: `Idea slide. Headline text: "What if you could just point?" A mouse cursor clicking a UI element that elegantly morphs into a small rounded chat "chip" inside a message box. Clean, elegant, one clear motion.`,
  },
  {
    file: "slide-04-demo.png",
    prompt: `Section divider slide. One huge word: "DEMO". A small play-triangle icon and a coral starburst accent. Minimal, lots of dark space.`,
  },
  {
    file: "slide-05-what-happened.png",
    prompt: `Process slide. Headline text: "Point. Context. Fix. Reload." A four-step horizontal flow with tiny line icons for each: a cursor, code brackets, a wrench, a refresh arrow. Numbered 1 to 4, connected by a thin line.`,
  },
  {
    file: "slide-06-beyond-css.png",
    prompt: `Capability slide. Headline text: "It's not just CSS." A left-to-right pipeline: a code block, then a git commit dot, then a deploy cloud, ending in a big green checkmark labeled "deployed". Conveys write → commit → deploy → verify on a live site.`,
  },
  {
    file: "slide-07-architecture.png",
    prompt: `Architecture diagram slide. Headline text: "Four pieces, one pipe." A clean left-to-right flow of four labeled boxes connected by arrows: "Chrome Extension", "Native Messaging", "Node.js Host", "Claude Code". A small glowing dot travels along the pipe. Technical but tidy.`,
  },
  {
    file: "slide-08-decisions.png",
    prompt: `Decisions slide. Headline text: "Reuse > rebuild." Three items with red strikethroughs — "API key", "Playwright", "another AI" — resolving via an arrow into one green checkmark labeled "Claude Code + your browser".`,
  },
  {
    file: "slide-09-browse.png",
    prompt: `Integration slide. Headline text shown as a terminal command: "/browse localhost:3000". A terminal window with that command, an arrow to a browser opening, and an arrow to a side-panel "Sources" list auto-filling. Show the automatic sync.`,
  },
  {
    file: "slide-10-weekend.png",
    prompt: `Story slide. Headline text: "41 commits. One Sunday." A git-style vertical bar chart where one enormous bar (labeled 41) towers over three tiny bars. A subtle calendar motif in the background.`,
  },
  {
    file: "slide-11-lessons.png",
    prompt: `Lessons slide. Headline text: "Stand on a platform." Three clean stacked horizontal takeaway bars with short labels, plus a small figure standing confidently on a solid platform/foundation block. Lots of whitespace.`,
  },
  {
    file: "slide-12-traction.png",
    prompt: `Traction slide. Big headline number text: "~1,000 weekly users". Smaller text: "+782% in 30 days" and "5.0 stars". A confident upward-trending line chart climbing toward 1K with a soft glow, and a row of five stars. Optimistic, growth.`,
  },
  {
    file: "slide-13-close.png",
    prompt: `Closing slide. Headline text: "Stop describing your UI. Point at it." A code pill showing "npx claude-code-browser install" and a QR-code placeholder square. A large coral starburst logo, bookending the title slide.`,
  },
];

async function generate(slide) {
  const body = {
    model: MODEL,
    prompt: `${STYLE}\n\n${slide.prompt}`,
    size: SIZE,
    quality: QUALITY,
    n: 1,
    output_format: "png",
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`No image in response: ${JSON.stringify(json).slice(0, 300)}`);

  const outPath = path.join(OUT_DIR, slide.file);
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  return outPath;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const filter = process.argv[2];
  const todo = filter ? SLIDES.filter((s) => s.file.includes(filter)) : SLIDES;
  if (todo.length === 0) {
    console.error(`✗ No slide matches "${filter}". Available:\n  ${SLIDES.map((s) => s.file).join("\n  ")}`);
    process.exit(1);
  }

  console.log(`Generating ${todo.length} slide(s) with ${MODEL} (${SIZE}, quality=${QUALITY})...\n`);

  let ok = 0;
  for (const slide of todo) {
    process.stdout.write(`  • ${slide.file} ... `);
    try {
      const t0 = Date.now();
      await generate(slide);
      console.log(`done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      ok++;
    } catch (err) {
      console.log("FAILED");
      console.error(`    ${err.message}`);
    }
  }

  console.log(`\n${ok}/${todo.length} slides written to ${path.relative(process.cwd(), OUT_DIR)}/`);
}

main();
