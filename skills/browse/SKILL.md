---
name: browse
description: Open a URL in Chrome for visual inspection. Use when you need to see a web page, inspect UI, debug visual issues, or test web apps. Works with the Claude Code Browser extension.
argument-hint: <url>
---

Open `$ARGUMENTS` in Chrome for inspection.

## Check extension

!`ls ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.claude_code_browser.json 2>/dev/null && echo "EXTENSION_INSTALLED" || ls ~/.config/google-chrome/NativeMessagingHosts/com.claude_code_browser.json 2>/dev/null && echo "EXTENSION_INSTALLED" || echo "EXTENSION_NOT_INSTALLED"`

## Setup sources

Register the current workspace directory as a source for the target domain:
```bash
URL="$ARGUMENTS"
DOMAIN=$(echo "$URL" | sed -E 's|^https?://||;s|[:/].*||')
[ -z "$DOMAIN" ] && DOMAIN="$URL"
mkdir -p /tmp/ccb-sources
echo "{\"domain\":\"$DOMAIN\",\"paths\":[\"$(pwd)\"]}" > /tmp/ccb-sources/pending.json
echo "Source registered: $(pwd) -> $DOMAIN"
```

## Instructions

If EXTENSION_NOT_INSTALLED:
- Tell the user to install: Chrome Web Store then `npx claude-code-browser install`
- Do NOT proceed until confirmed.

If EXTENSION_INSTALLED:
- Open the URL:
```bash
if [ "$(uname)" = "Darwin" ]; then
  open -a "Google Chrome" "$ARGUMENTS"
elif [ "$(uname)" = "Linux" ]; then
  xdg-open "$ARGUMENTS"
else
  start chrome "$ARGUMENTS"
fi
```
- Tell the user: "Page opened. Workspace source registered. Open the side panel to start. Add more source directories from the Sources panel if needed."
