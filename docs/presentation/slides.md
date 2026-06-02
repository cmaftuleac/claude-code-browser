# Slide outline — Claude Code Browser

~14 content slides + title + closing. Keep text sparse; you narrate the rest. Visual notes in _italics_. Real screenshots live in [`images/`](images/).

---

### Slide 0 — Title
**Claude Code Browser**
Point at it. Ask. Fixed.

- Your name / handle (@cmaftuleac · Fineguide.AI)
- "A weekend project that ended up on the Chrome Web Store"

_Visual: `images/03-webstore-listing.png` — the live listing (5.0★, 946 users) makes "shipped" the first thing they see._

---

### Slide 1 — Cold open (hook)
**"The button is the wrong color."**

- One line, nothing else.

_Visual: a real UI with a slightly-off button. Big and simple. This is the setup for the problem._

---

### Slide 2 — The problem
**Telling an AI *which* thing is slow**

- You can describe code to an AI easily.
- Describing a **pixel on a screen**? Painful.
- Today's loop: screenshot → "the third card" → paste a selector → "no, the *other* one" → guess.

_Visual: messy collage — a screenshot with red arrows, a copy-pasted CSS selector, a frustrated chat thread._

---

### Slide 3 — The idea
**What if you could just… point?**

- Click the element. Claude sees it *and* your source code.
- No screenshots. No selectors. No describing.
- "Fix the color of ⦾ `<button>`" — the element *is* the reference.

_Visual: a cursor clicking an element → it turns into a chip inside a chat box._

---

### Slide 4 — Demo intro
**Let's just show it**

- localhost app, real source code, live fix.

_Visual: blank / "DEMO" holding slide so you can switch to the screen. See `demo-runbook.md`._

---

### Slide 5 — (DEMO — no slide)
_Screen share. Title bar slide optional. Run the runbook._

---

### Slide 6 — What just happened
**Point → context → fix → reload**

1. Clicked element → captured selector, XPath, DOM path, HTML snippet
2. Sent to Claude Code as a rich reference (a "chip")
3. Claude read the **actual source files** and edited them
4. Browser reloaded — fix is live

_Visual: 4 numbered steps, each with a tiny icon._

---

### Slide 6b — It's not just CSS
**…and it doesn't stop at "edit a file"**

- Same point-and-ask flow, bigger job: "add the GDPR cookie dialog."
- Claude wrote it, **committed, pushed, deployed to production** (docker + nginx + Cloudflare purge), then **verified it live**.
- The browser is the loop: build → ship → check the real site.

_Visual: `images/01-sidepanel-deploy.png` — the deploy + production-verification checklist. Let it land for a second; it reframes the whole tool._

---

### Slide 7 — How it works (architecture)
**Four pieces, one pipe**

```
Chrome Extension  ──Native Messaging──▶  Node.js Host  ──Agent SDK──▶  Claude Code
   (React, MV3)                          (local bridge)               (your CLI)
        │                                      │
   chrome.debugger                       browser tool defs
   navigate · snapshot ·                 (navigate, click,
   screenshot · click · eval             snapshot, screenshot…)
```

- Extension = UI + element picker + browser control
- Native host = the bridge Chrome launches for you
- Agent SDK = streaming, sessions, custom tools
- Claude Code = the brain, already on your machine

_Visual: the diagram, animated to trace one click left-to-right then back._

---

### Slide 8 — The three decisions that made it simple
**Reuse > rebuild**

- **No API key.** Reuses your existing Claude Code auth.
- **No Playwright / no separate browser.** Drives *your* Chrome via `chrome.debugger`.
- **No new "AI" — it's Claude Code.** Same agent, same skills, new eyes.

_Visual: three crossed-out logos (API key, Playwright, "another AI app") → one green check: "Claude Code + your browser." Optionally show `images/04-setup-screen.png` — the onboarding literally says "uses your existing Claude Code account, nothing new to sign in to."_

---

### Slide 9 — The /browse skill (the glue)
**`/browse localhost:3000`**

- One command in your editor opens the page **and** tells the extension which folders are *your* source.
- That's why Claude can read & edit the right files — not guess.

_Visual: terminal typing `/browse localhost:3000` → Chrome opens → Sources panel fills in._

---

### Slide 10 — The weekend story
**41 commits. One Sunday.**

- Mar 30, 2026: core built in a day.
- May: polish, multi-session, Chrome Web Store + npm release.
- ~5,200 lines of TypeScript.

_Visual: the literal `git log` day histogram (41 / 9 / 4 / 3). Real screenshots beat claims._

---

### Slide 11 — What I'd tell weekend-hackers
**Lessons**

- **Stand on a platform.** The Agent SDK + Claude Code auth removed 80% of the work.
- **The boring 20% is the real ship.** Native-messaging install, cross-platform paths, store review — that's most of the May commits.
- **A sharp demo > a feature list.** "Point and fix" sold it in 10 seconds.

_Visual: three short lines, lots of whitespace._

---

### Slide 12 — Where it is now
**Shipped — and people are using it**

- ~**1,000 weekly users**, **+782%** in 30 days
- **946 installs**, **5.0★** on the Chrome Web Store
- One command to set up: `npx claude-code-browser install`
- Open source (MIT) on GitHub

_Visual: `images/02-analytics-users.png` (the growth curve) — real numbers beat any claim. Optionally pair with `images/03-webstore-listing.png`._

---

### Slide 13 — Close
**Stop describing your UI. Point at it.**

- Try it tonight: `npx claude-code-browser install`
- github.com/cmaftuleac/claude-code-browser
- @cmaftuleac · Fineguide.AI
- "Questions?"

_Visual: the title-slide image again + QR code. Bookend._
</content>
