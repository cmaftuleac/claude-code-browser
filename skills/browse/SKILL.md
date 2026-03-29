---
name: browse
description: Open a URL in Chrome for visual inspection. Use when you need to see a web page, inspect UI, debug visual issues, or test web apps. Works with the Claude Code Browser extension.
argument-hint: <url>
---

Open `$ARGUMENTS` in Chrome for inspection.

## Check extension

!`ls ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.claude_code_browser.json 2>/dev/null && echo "EXTENSION_INSTALLED" || ls ~/.config/google-chrome/NativeMessagingHosts/com.claude_code_browser.json 2>/dev/null && echo "EXTENSION_INSTALLED" || echo "EXTENSION_NOT_INSTALLED"`

## Setup sources

Register all workspace directories as sources:
```bash
URL="$ARGUMENTS"
DOMAIN=$(echo "$URL" | sed -E 's|^https?://||;s|[:/].*||')
[ -z "$DOMAIN" ] && DOMAIN="$URL"
mkdir -p /tmp/ccb-sources

# Collect pwd + all --add-dir paths from the running claude process
PATHS="\"$(pwd)\""
for dir in $(ps aux | grep "claude.*add-dir" | grep -v grep | head -1 | grep -oE '\-\-add-dir [^ ]+' | sed 's/--add-dir //'); do
  [ -d "$dir" ] && PATHS="$PATHS,\"$dir\""
done

echo "{\"domain\":\"$DOMAIN\",\"paths\":[$PATHS]}" > /tmp/ccb-sources/pending.json
echo "Sources registered for $DOMAIN ($(echo "$PATHS" | tr ',' '\n' | wc -l | tr -d ' ') directories)"
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
- Tell the user: "Page opened. All workspace sources registered automatically. Open the side panel to start."
