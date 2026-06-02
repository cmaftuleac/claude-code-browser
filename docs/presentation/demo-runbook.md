# Demo runbook — the live "point and fix"

The demo is the centerpiece (~4 min). Rehearse it until it's boring. Have a recorded fallback.

## Before the talk (setup checklist)

- [ ] Extension installed and showing **Connected** (green dot) in the side panel.
- [ ] Claude Code authenticated and working in a terminal.
- [ ] A small demo web app running on `localhost` with **source you can edit** (a button + a card is plenty).
- [ ] In the editor, already ran `/browse localhost:3000` so **Sources** is populated. _(Do this off-camera; doing it live is fine but adds risk.)_
- [ ] Chrome window + side panel sized so both the page and the chat are readable on the projector. Bump font size.
- [ ] Network: model calls need internet. **Test on the venue wifi during setup**, not at showtime.
- [ ] **Recorded fallback video** loaded and ready in another tab/window (see bottom).

## The script (what to click, what to say)

1. **Set the scene.** "Normal app on localhost, extension in the side panel." Point at both.
2. **Activate the picker.** Click the **⌖** button. Mention "now I'm in pick mode."
3. **Click the target element** (the off-color button). It becomes a **chip** in the chat input. Call it out: "that chip *is* the button — selector, position, HTML, all attached."
4. **Type a human request:** `make this button blue and a little bigger`. Send.
5. **Narrate the agent working** — emphasize it's reading *real source files*, not guessing from a screenshot. Watch the streaming output.
6. **Show the result** — page reloads / updates, button is blue. "I never gave it a filename or a selector."
7. **(Optional, if under time)** Pick a second element and fix spacing or text. Keep under 60s.

## Failure handling (decide the rule *now*)

- If the model call stalls > ~10 seconds: keep talking, don't stare at the screen. If > ~20s, say "this is exactly why I recorded it" and cut to the fallback video.
- If the picker doesn't attach: reload the page once (content script auto-injects), try once more, then go to fallback.
- **One retry max, then fallback.** Never debug live.

## Recorded fallback

- Record a clean run of steps 1–7 ahead of time (screen capture, 60–90s, with the same narration beats).
- Keep it paused on the first frame in a ready window so switching is one click.
- A smooth recording beats a flaky live demo every time — no one in the audience will care.

## Reset between rehearsals

- `git checkout` the demo app's source file to undo the edit so each run starts from the off-color button.
</content>
