# TapThat

Comment on a **live webpage** the way you comment on a design, then export every comment
as one markdown prompt with enough DOM context for a coding agent to find the matching
source and apply the change.

Chromium MV3 extension — works in Chrome and Arc.

## Install

1. Open `chrome://extensions` (Chrome) or `arc://extensions` (Arc).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.

That's the whole install. No server, no account, no configuration.

## Use

Activate annotation mode in any of three ways:

- The **floating button**, which appears automatically on localhost and other local dev
  hosts. Drag it anywhere; the position is remembered across pages and sessions.
- **Alt+Shift+C** (rebindable at `chrome://extensions/shortcuts`)
- The toolbar icon

| Action | Result |
| --- | --- |
| Hover | Blue border tracks the element under the cursor |
| `↑` / `↓` | Walk up to the parent element, or back down |
| Click | Freeze that element and open the comment box |
| `⌘↵` | Save the comment |
| `Esc` | Cancel the comment, or exit annotation mode |
| Click a pin | Reopen a comment to edit, resolve or delete it |
| **Export** | Copy all open comments as one markdown prompt to the clipboard |

Paste the result into Claude Code (or any agent) pointed at the app's repo.

Comments persist per-URL, so they survive reloads and SPA navigation. Mark a comment
resolved with the ✓ in the panel — resolved comments leave the page and are left out of
exports, so an agent is never asked to redo finished work.

## There's also a Full mode

Instead of copying a prompt and pasting it into an agent yourself, TapThat can send
comments straight to an agent running beside your dev server, so the change appears in
the page within seconds. It's the same extension — configuring a sidecar URL in the
options page is the entire difference.

See the project page for setup: https://github.com/ludellevold/tapthat

## License

MIT — see [LICENSE](LICENSE).
