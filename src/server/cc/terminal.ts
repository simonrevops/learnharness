import { execFile } from "node:child_process";

/**
 * macOS Terminal driver — the same AppleScript the Factory UI uses. A lesson's
 * Claude Code session is a real Terminal tab the learner can watch and type
 * into; LearnHarness types the learner's messages into it.
 */

const LAUNCH = `on run argv
  tell application "Terminal"
    set t to do script (item 1 of argv)
    return tty of t
  end tell
end run`;

/** Bracketed-paste markers tell Claude Code where the text ends, so the Return
 *  that `do script` appends is a real Enter (unmarked, a fast burst is guessed
 *  to be a paste and the Return is swallowed into it). */
const TYPE_INTO_TAB = `on run argv
  set theTty to item 1 of argv
  set theText to item 2 of argv
  set esc to character id 27
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is theTty then
          do script (esc & "[200~" & theText & esc & "[201~") in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "no tab"
end run`;

const KEY_INTO_TAB = `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is (item 1 of argv) then
          do script (item 2 of argv) in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "no tab"
end run`;

const FOCUS_TAB = `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is (item 1 of argv) then
          set selected of t to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "no tab"
end run`;

function osascript(script: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("osascript", ["-e", script, ...args], { timeout: 15_000 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`osascript failed: ${stderr || err.message}`));
			else resolve(stdout.trim());
		});
	});
}

/** Open a new Terminal tab running `command`; resolves to its tty. */
export function openTab(command: string): Promise<string> {
	return osascript(LAUNCH, [command]);
}

/** Type one message into the tab and submit it. */
export async function typeInto(tty: string, text: string): Promise<boolean> {
	return (await osascript(TYPE_INTO_TAB, [tty, text])) === "ok";
}

/** Send a raw key sequence (e.g. ESC to interrupt). */
export async function keyInto(tty: string, keys: string): Promise<boolean> {
	return (await osascript(KEY_INTO_TAB, [tty, keys])) === "ok";
}

export async function focusTab(tty: string): Promise<boolean> {
	return (await osascript(FOCUS_TAB, [tty])) === "ok";
}

/** Single-quote a string for the shell command line `do script` runs. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
