#!/usr/bin/env node
// Generate presentation slides as images using Google's "Nano Banana 2"
// (gemini-3.1-flash-image-preview). Real product screenshots are passed as
// input images so the model composites them into the slide instead of faking them.
//
// On-slide text is in ROMANIAN. QR codes and the Fineguide logo are NOT drawn by
// the model — slides 01 and 09 leave space, and compose-overlays.sh composites the
// real (scannable) assets afterwards with ImageMagick.
//
// Usage:
//   GOOGLE_API_KEY=AIza... node docs/presentation/generate-slides-gemini.mjs            # all slides
//   GOOGLE_API_KEY=AIza... node docs/presentation/generate-slides-gemini.mjs slide-08   # one slide (prefix match)
//
// The key is read from the environment only — never hardcode it in this file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("✗ GOOGLE_API_KEY is not set. Run: GOOGLE_API_KEY=AIza... node docs/presentation/generate-slides-gemini.mjs");
  process.exit(1);
}

const MODEL = process.env.MODEL || "gemini-3.1-flash-image-preview"; // Nano Banana 2
const ASPECT = process.env.ASPECT || "16:9";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG_DIR = path.join(__dirname, "images");
const OUT_DIR = path.join(IMG_DIR, "generated");

// Shared art direction prepended to every prompt for a consistent deck.
const STYLE = [
  "Design a professional, polished tech-conference presentation slide in 16:9 landscape.",
  "Dark theme: deep charcoal-navy background (#10131c) with a subtle dotted grid.",
  "Brand accents: a warm coral-orange 8-point starburst/sunburst logo mark, and soft indigo-purple (#7c6cf0) highlights.",
  "Clean modern sans-serif typography, large readable headline, generous whitespace, flat minimal vector illustration.",
  "All on-slide text is in ROMANIAN. Render the quoted Romanian text exactly and correctly, INCLUDING diacritics (ă â î ș ț). Keep on-slide text minimal.",
].join(" ");

// When a slide includes screenshots, this instruction protects the real data.
const SCREENSHOT_RULE =
  "IMPORTANT: place the provided screenshot(s) into the slide UNALTERED — like a photo pasted onto the slide. Do NOT redraw, restyle, translate, or change any text, numbers, charts or pixels inside the screenshot. Keep them crisp and fully legible. " +
  "This is a DESKTOP browser product: present each screenshot in a plain floating card with rounded corners and a soft drop shadow. NEVER wrap a screenshot in a phone, smartphone, tablet or any mobile-device frame.";

const SLIDES = [
  {
    // 0 — Title + product screenshot
    file: "slide-00-title.png",
    inputs: ["01-sidepanel-deploy.png"],
    prompt: `Title slide. Large headline: "Claude Code Browser". Below it a plain descriptive subtitle (Romanian, not a slogan): "Extensie Chrome care leagă pagina din browser de Claude Code". Big coral starburst logo near the headline on the left. On the right, show the provided side-panel screenshot as the hero product shot, in a plain floating card with rounded corners and a soft shadow. ${SCREENSHOT_RULE}`,
  },
  {
    // 1 — Intro: Corneliu + Fineguide.AI  (logo + QR composited later, keep right side clear)
    file: "slide-01-intro.png",
    inputs: [],
    prompt: `Speaker intro slide. Put ALL text on the LEFT half; keep the entire RIGHT half empty dark space (a logo and a QR code will be added there later). Left side, top to bottom: small label "PREZINTĂ", then large headline "Fineguide.AI", then a short descriptive line in a pill (Romanian, factual, not a slogan): "Platformă de business automatizare cu AI". A coral starburst accent near the headline. Do not draw any logo or QR code yourself.`,
  },
  {
    // 2 — Problem
    file: "slide-02-problem.png",
    inputs: [],
    prompt: `Problem slide. Headline (Romanian, a clear question, not a slogan): "Cum îi arăți unui AI exact ce element să modifice?" Visualize a frustrating game of telephone between a human and an AI: a browser screenshot with red arrows, a pasted CSS selector code snippet, a confused chat thread. Slightly chaotic, conveys friction.`,
  },
  {
    // 3 — Solution 1/3: the idea (+ real screenshot)
    file: "slide-03-solution-idea.png",
    inputs: ["slide03-src.png"],
    prompt: `Idea slide. Put the text and illustration on the LEFT ~45%, the screenshot on the RIGHT ~55%. Left: small label (Romanian) "SOLUȚIA 1/3", then headline (Romanian, descriptive, not a slogan): "Selectezi elementul direct în pagină", then a small flat illustration of a mouse cursor clicking a UI element that morphs into a rounded chat "chip". On the right, show the provided screenshot (the side panel inspecting a page element) in a plain floating card with rounded corners and a soft shadow. ${SCREENSHOT_RULE}`,
  },
  {
    // 4 — Solution 2/3: the flow (+ real screenshot)
    file: "slide-04-solution-flow.png",
    inputs: ["slide04-src.png"],
    prompt: `Process slide. Put the text and step-flow on the LEFT ~45%, the screenshot on the RIGHT ~55%. Left: small label (Romanian) "SOLUȚIA 2/3", then headline (Romanian, descriptive, not a slogan): "Cum funcționează, pas cu pas", then a compact vertical four-step flow numbered 1-4, each with a tiny line icon and a short Romanian label: 1 cursor "selectează", 2 code brackets "context", 3 a wrench "modifică", 4 a refresh arrow "reîncarcă". On the right, show the provided screenshot (a page element selected, turning into a chip reference) in a plain floating card with rounded corners and a soft shadow. ${SCREENSHOT_RULE}`,
  },
  {
    // 5 — Solution 3/3: beyond CSS
    file: "slide-05-solution-beyond-css.png",
    inputs: [],
    prompt: `Capability slide, small top-left label (Romanian) "SOLUȚIA 3/3". Headline (Romanian, descriptive, not a slogan): "De la o ajustare la o funcționalitate completă" Subtitle, a real process pipeline (Romanian): "scrie → commit → deploy → verifică". A clean left-to-right pipeline illustration: a code block, a git commit dot, a deploy cloud, ending in a big green check mark labelled (Romanian) "verificat live". Conveys shipping a whole feature, not just a tweak.`,
  },
  {
    // 6 — Architecture + setup screenshot
    file: "slide-06-architecture.png",
    inputs: ["04-setup-screen.png"],
    prompt: `Architecture slide. Headline top-left (Romanian, descriptive, not a slogan): "Arhitectura: patru componente" Below it a clean left-to-right flow of four labelled rounded boxes connected by arrows, labels kept in English: "Chrome Extension", "Native Messaging", "Node.js Host", "Claude Code". On the right, show the provided "Setup Required" onboarding screenshot in a plain floating card with rounded corners and a soft shadow, to illustrate the local bridge. ${SCREENSHOT_RULE}`,
  },
  {
    // 7 — Examples / live demo divider
    file: "slide-07-demo.png",
    inputs: [],
    prompt: `Section divider for the live demo. One huge word: "DEMO". Smaller subtitle (Romanian): "Exemple live". A small play-triangle icon and a coral starburst accent. Minimal, lots of dark space.`,
  },
  {
    // 8 — Metrics from the Chrome Web Store (two real screenshots)
    file: "slide-08-metrics.png",
    inputs: ["02-analytics-users.png", "03-webstore-listing.png"],
    prompt: `Metrics slide. Headline top-left (Romanian): "Cifre din Chrome Web Store." Show the TWO provided screenshots side by side inside subtle floating cards: the weekly-users growth chart, and the Chrome Web Store listing. Small caption under them (Romanian): "~1.000 utilizatori săptămânal · +782% în 30 de zile · 5,0 stele". ${SCREENSHOT_RULE}`,
  },
  {
    // 9 — End + QR to the store (QR composited later, keep bottom-right clear)
    file: "slide-09-end.png",
    inputs: [],
    prompt: `Closing slide. Put ALL text and the logo on the LEFT 60% of the slide; keep the entire RIGHT 40% completely empty dark space (a QR code will be added there later). Left side, stacked: a large coral starburst logo, then headline (Romanian, descriptive, not a slogan) "Instalează din Chrome Web Store", then a terminal-style code pill containing the exact text (keep in English) "npx claude-code-browser install", then a small muted line (Romanian) "Scanează codul sau caută «Claude Code Browser»". Do not let any text cross into the right 40%. Do not draw any QR code yourself.`,
  },
];

function loadImagePart(file) {
  const p = path.join(IMG_DIR, file);
  const data = fs.readFileSync(p).toString("base64");
  return { inline_data: { mime_type: "image/png", data } };
}

async function generate(slide) {
  const parts = [{ text: `${STYLE}\n\n${slide.prompt}` }];
  for (const f of slide.inputs || []) parts.push(loadImagePart(f));

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: ASPECT },
    },
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`);
  }

  const json = await res.json();
  const outParts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = outParts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) {
    const textPart = outParts.find((p) => p.text)?.text;
    throw new Error(`No image in response. ${textPart ? "Model said: " + textPart.slice(0, 300) : JSON.stringify(json).slice(0, 300)}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, slide.file), Buffer.from(b64, "base64"));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const filter = process.argv[2];
  const todo = filter ? SLIDES.filter((s) => s.file.includes(filter)) : SLIDES;
  if (todo.length === 0) {
    console.error(`✗ No slide matches "${filter}". Available:\n  ${SLIDES.map((s) => s.file).join("\n  ")}`);
    process.exit(1);
  }

  console.log(`Generating ${todo.length} slide(s) with ${MODEL} (aspect ${ASPECT})...\n`);

  let ok = 0;
  for (const slide of todo) {
    const tag = slide.inputs?.length ? ` [+${slide.inputs.length} screenshot]` : "";
    process.stdout.write(`  • ${slide.file}${tag} ... `);
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
  console.log(`Next: bash docs/presentation/compose-overlays.sh   # composite the QR codes + logo`);
}

main();
