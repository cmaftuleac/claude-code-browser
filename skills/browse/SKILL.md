---
name: browse
description: Open a URL in Chrome for visual inspection. Use when you need to see a web page, inspect UI, debug visual issues, or test web apps. Works with the Claude Code Browser extension.
argument-hint: <url>
---

Open `$ARGUMENTS` in Chrome for inspection.

## Check extension

!`ls ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.claude_code_browser.json 2>/dev/null && echo "EXTENSION_INSTALLED" || ls ~/.config/google-chrome/NativeMessagingHosts/com.claude_code_browser.json 2>/dev/null && echo "EXTENSION_INSTALLED" || echo "EXTENSION_NOT_INSTALLED"`

## Instructions

If EXTENSION_NOT_INSTALLED:
- Tell the user: "The Claude Code Browser extension is not installed. Install it from the Chrome Web Store: https://chromewebstore.google.com/detail/claude-code-browser/ then run `npx claude-code-browser install`"
- Do NOT proceed with opening the URL until the user confirms installation.

If EXTENSION_INSTALLED:
- Open the URL in Chrome:
```bash
if [ "$(uname)" = "Darwin" ]; then
  open -a "Google Chrome" "$ARGUMENTS"
elif [ "$(uname)" = "Linux" ]; then
  xdg-open "$ARGUMENTS"
else
  start chrome "$ARGUMENTS"
fi
```
- Tell the user: "Page opened in Chrome. Click the Claude Code Browser extension icon (puzzle piece → Claude Code Browser) to open the side panel, then select elements and chat about them."

The workspace is at: !`pwd`
