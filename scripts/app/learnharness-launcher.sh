#!/bin/bash
# LearnHarness.app (fork): start the LearnHarness server on the Claude Code engine if it isn't
# running, then open (or bring forward) the page in its own Chrome app window — Factory.app's pattern.
REPO="$HOME/dev/learnharness-cc"
PORT=3417
URL="http://localhost:$PORT/"  # localhost: next dev blocks its page scripts on 127.0.0.1
# Apps opened from Finder don't get the shell's PATH: find Node ourselves.
NODE="$(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1)"
[ -x "$NODE" ] || NODE="$(command -v node)"
if ! curl -s -o /dev/null --max-time 1 "$URL"; then
  mkdir -p "$REPO/data/logs"
  cd "$REPO" || exit 1
  LH_ENGINE=claude-code NEXT_PUBLIC_LH_ENGINE=claude-code LH_CC_URL="http://127.0.0.1:$PORT" PORT=$PORT \
    PATH="$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:$PATH" \
    nohup "$NODE" node_modules/next/dist/bin/next dev -p $PORT >> "$REPO/data/logs/server.log" 2>&1 &
  disown
  # The first page compiles on request: wait up to two minutes.
  for i in $(seq 1 120); do curl -s -o /dev/null --max-time 3 "$URL" && break; sleep 1; done
fi
# Chrome doesn't list app windows to AppleScript, so find ours by its title and raise it.
found=$(osascript -e 'tell application "System Events"' -e 'if not (exists process "Google Chrome") then return "no"' \
  -e 'repeat with w in (windows of process "Google Chrome")' \
  -e 'if name of w starts with "Learning Harness" then' -e 'perform action "AXRaise" of w' \
  -e 'set frontmost of process "Google Chrome" to true' -e 'return "yes"' -e 'end if' -e 'end repeat' \
  -e 'end tell' -e 'return "no"' 2>/dev/null)
[ "$found" = "yes" ] || open -na "Google Chrome" --args --app="$URL"
