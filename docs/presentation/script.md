# Speaker script — Claude Code Browser

~13 minutes spoken. `[S#]` markers map to slides in [`slides.md`](slides.md). `(beat)` = pause. Bracketed italics are stage directions, not spoken.

Target pace ~130 wpm. Don't rush the demo; cut the architecture details before you cut the demo.

---

## 1 · Cold open — 1:00

**[S0 — title]**

Hi everyone. I'm Corneliu. (beat) I want to start with a complaint.

**[S1 — "the button is the wrong color"]**

You're working with an AI coding agent. It's great at code. And then you look at the screen and you think: "that button is the wrong color." (beat) Simple thought. Now try to *tell the AI which button.*

That tiny gap — between what you see and what the AI can act on — is the whole reason this project exists. This is **Claude Code Browser**, and the honest subtitle is: a weekend project that somehow ended up on the Chrome Web Store.

---

## 2 · The problem — 1:30

**[S2 — the problem]**

Here's the thing. Describing *code* to an AI is easy — you paste it, you point at a function. But describing a **pixel on a screen** is weirdly hard.

So we've all developed this ritual. You take a screenshot. You write "the third card, no — the one on the right." You open dev tools, copy a CSS selector, paste it in. The agent guesses. It picks the wrong element. You try again. (beat)

It's a game of telephone between your eyeballs and the agent. And every round of that telephone is friction. For a tool that's supposed to make you faster, that's the part that still feels like 2015.

---

## 3 · The idea — 1:00

**[S3 — the idea]**

So the idea — and it really is just one idea — was: **what if you could just point?**

Click the element. That's it. The agent now knows *exactly* which thing you mean — and, crucially, it can also read your source code. So instead of "the third card," you literally write: "fix the color of —" and then there's a little chip in your message that *is* that button. The element becomes a first-class reference, sitting right there in the sentence next to your words. (beat)

No screenshots. No selectors. No describing. Let me show you, because it's the kind of thing that's faster to see than to explain.

---

## 4 · Demo — 4:00

**[S4 — DEMO holding slide, then switch to screen]**

_[Follow `demo-runbook.md`. Narrate every action — meetup audiences lose the thread fast on a shared screen.]_

Okay. This is a normal little web app running on localhost. Over here on the right is the side panel — that's the extension.

I'm going to click this picker button... and now I just **click the element** I care about. (beat) See that? It became a chip in my chat box. Behind that chip the agent now has the selector, the position, the HTML — everything.

Now I type like a human: "make this button blue and a bit bigger." Send. (beat)

And watch — it's not screenshotting and guessing. It's **reading my actual source files**, finding the component, and editing it. (beat) ...There. The page reloads, and the button's blue. I never told it a filename. I never told it a selector. I pointed and asked.

_[If time: do one more — pick a second element, fix spacing. Keep it under a minute.]_

That's the whole pitch. Everything else is how it works.

---

## 5 · What just happened — 1:00

**[S6 — point → context → fix → reload]**

Let me slow that down, because four things happened in those few seconds.

One — when I clicked, the extension captured the element: its CSS selector, its XPath, its full DOM path, and the HTML snippet. Two — that got handed to Claude Code as a rich reference, not a screenshot. Three — Claude read the *real* source files on my disk and made the edit. Four — the browser reloaded and the change was live. (beat) Point, context, fix, reload.

**[S6b — it's not just CSS / deploy screenshot]**

And — quick reframe, because "fix a color" undersells it. Same flow, much bigger job. _[show deploy screenshot]_ This is a real session: "add the GDPR cookie dialog." Claude wrote it, **committed it, pushed it, deployed it to production** — docker rebuild, nginx reload, Cloudflare cache purge — and then **opened the live site and verified it**. (beat) The browser isn't just where you point. It's where you check that the thing actually shipped. Build, deploy, verify — same loop.

---

## 6 · How it works — 3:00

**[S7 — architecture diagram]**

So how does a Chrome extension end up editing files on your laptop? Because normally — it can't. Extensions are sandboxed. That's the interesting engineering problem.

There are four pieces. _[trace the diagram left to right]_

On the left, the **Chrome extension** — React, Manifest V3, living in the side panel. It does the UI, the element picker, and it can drive the browser.

It talks to a small **Node.js host** running on your machine, through something called **Chrome Native Messaging** — which is the one sanctioned escape hatch a browser extension has to talk to a local program. Chrome launches that host for you; you don't babysit a server.

That host uses the **Claude Agent SDK** to drive **Claude Code** — the same CLI a lot of you already have installed.

**[S8 — three decisions]**

And the reason a weekend was enough comes down to three decisions, all of the form "reuse, don't rebuild."

First — **no API key.** It piggybacks on the Claude Code you've already authenticated. No new account, no billing setup, nothing to paste.

Second — **no Playwright, no second browser.** A lot of agent-browser tools spin up a separate automated Chrome. This one drives the browser *you're already looking at*, through the `chrome.debugger` API — the same plumbing dev tools use. The agent can navigate, screenshot, click, run JavaScript — right there in your tab.

Third — **I didn't build an AI.** The brain is Claude Code. I just gave it eyes and a pointing finger. (beat) When you frame the work that way, the actual code is mostly a clean pipe between a browser and an agent that already exists.

**[S9 — /browse skill]**

One more piece of glue worth calling out. In your editor you type `/browse localhost:3000`. That does two things: it opens the page, and it tells the extension *which folders are your source code*. That's the secret to why Claude edits the right files instead of guessing — it's been handed your project directories explicitly.

---

## 7 · The weekend story + lessons — 1:30

**[S10 — 41 commits, one Sunday]**

Now, the weekend part — because I think the git history is the most honest slide here. _[point at histogram]_ Forty-one commits on a single Sunday in March. That's the core: the picker, the bridge, the agent loop. Then a long tail in May — multi-session support, the installer, and getting through Chrome Web Store review. About five thousand lines of TypeScript all in.

**[S11 — lessons]**

Three takeaways if you go build your own weekend thing.

**Stand on a platform.** The Agent SDK and reusing Claude Code's auth deleted maybe 80% of the work before I wrote a line.

**The boring 20% is the actual ship.** The fun part was done Sunday night. Cross-platform install paths, native-messaging quirks, store review — that's what those May commits are. Shipping is the long tail, not the demo.

And — **a sharp demo beats a feature list.** "Point and fix" lands in ten seconds. Nobody installs a bullet list.

---

## 8 · Where it is + close — 1:00

**[S12 — shipped + traction]**

And it's real — and it's not just me using it. _[show analytics]_ Right now it's around a thousand weekly users, up roughly 780% in the last month. Nearly a thousand installs on the Chrome Web Store, five-star rating. It's on npm, open source, MIT. One command to set up: `npx claude-code-browser install`.

**[S13 — close]**

So — the next time you catch yourself screenshotting your own app to explain it to an AI: (beat) don't describe your UI. **Point at it.**

Try it tonight, it's one command. I'm @cmaftuleac. (beat) Happy to take questions.

---

## Time-cut plan (if you're running long)

1. Drop the second demo fix (S4) — saves ~45s.
2. Compress S8 to just the "no API key / no Playwright" two lines — saves ~30s.
3. Merge S6 into the demo narration — saves ~30s.
- **Never** cut: the cold open, the live "point and fix" moment, and the "41 commits" slide.

## Likely Q&A — have answers ready

- **"Does it send my code to a server?"** No — the host runs locally and reuses your Claude Code session; see the privacy policy. Browser control is via local `chrome.debugger`.
- **"How is this different from Playwright MCP / browser-use?"** Those automate a *separate* browser. This drives the tab you're in, and the hook is the element picker — you point, you don't script.
- **"Does it work outside VS Code?"** Yes — the side panel works standalone; `/browse` also works from the Claude Code CLI.
- **"Why Native Messaging and not a WebSocket server?"** No port to manage, no server to start — Chrome launches the host on demand. (There's a legacy WS server in the repo from an earlier approach.)
- **"What does it cost?"** Uses your existing Claude Code plan — no extra key or subscription.
</content>
