---
name: browse
description: Open a URL in Chrome for visual inspection. Use when you need to see a web page, inspect UI, debug visual issues, or test web apps. Works with the Claude Code Browser extension.
argument-hint: <url>
---

Open `$ARGUMENTS` in Chrome for inspection.

## Check extension

!`ls ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.claude_code_browser.json 2>/dev/null && echo "EXTENSION_INSTALLED" || ls ~/.config/google-chrome/NativeMessagingHosts/com.claude_code_browser.json 2>/dev/null && echo "EXTENSION_INSTALLED" || echo "EXTENSION_NOT_INSTALLED"`

## Setup sources

Register all workspace directories as sources for the target domain:
!`echo "CWD=$(pwd)"`

```bash
URL="$ARGUMENTS"
DOMAIN=$(echo "$URL" | sed -E 's|^https?://||;s|[:/].*||')
[ -z "$DOMAIN" ] && DOMAIN="$URL"
mkdir -p /tmp/ccb-sources

# Collect all workspace paths - current dir plus any parent workspace dirs
PATHS="[\"$(pwd)\""

# Check if we're in a monorepo/workspace - add parent if it contains multiple projects
PARENT=$(dirname "$(pwd)")
if [ -d "$PARENT" ] && [ "$(ls -d "$PARENT"/*/ 2>/dev/null | wc -l)" -gt 1 ]; then
  # Add sibling directories (other projects in the workspace)
  for dir in "$PARENT"/*/; do
    dir="${dir%/}"
    if [ "$dir" != "$(pwd)" ] && [ -d "$dir" ]; then
      PATHS="$PATHS,\"$dir\""
    fi
  done
fi

PATHS="$PATHS]"
echo "{\"domain\":\"$DOMAIN\",\"paths\":$PATHS}" > /tmp/ccb-sources/pending.json
echo "Sources registered for $DOMAIN"
```

## Instructions

If EXTENSION_NOT_INSTALLED:
- Tell the user: "The Claude Code Browser extension is not installed. Install it from the Chrome Web Store then run `npx claude-code-browser install`"
- Do NOT proceed until the user confirms installation.

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
- Tell the user: "Page opened in Chrome. Workspace sources have been registered automatically. Open the Claude Code Browser side panel to start."
