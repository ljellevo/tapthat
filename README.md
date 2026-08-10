# Agentivision

Comment on a **live webpage** the way you comment on a design, then export every
comment as one markdown prompt with enough DOM context for a coding agent to find
the matching source and apply the change.

Chromium MV3 extension — works in Chrome and Arc. No build step required to use it.

```
hover an element  →  click  →  type "make this green"  →  Export  →  paste into your agent
```

## Install

**From a release** (no tooling needed):

1. Download `agentivision.zip` from [the latest release](../../releases/latest) and unzip it.
2. Open `chrome://extensions` (Chrome) or `arc://extensions` (Arc).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped `agentivision` folder.

**From source:**

```bash
git clone <this repo> && cd agentivision
npm install
```

`npm install` builds `dist/` for you. Then load unpacked as above, selecting the repo
folder.

## Use

Activate annotation mode in any of three ways:

- The **floating button**, which appears automatically on localhost and other local
  dev hosts. Drag it anywhere; the position is remembered across pages and sessions.
- **Alt+Shift+C** (rebindable at `chrome://extensions/shortcuts` or `arc://extensions/shortcuts`)
- The toolbar icon

Then:

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

Comments persist per-URL in `chrome.storage.local`, so they survive reloads and
SPA navigation. Pins stay visible after you exit annotation mode; if a commented
element no longer exists, its pin greys out and the export flags it as stale.

### Resolving

Mark a comment resolved with the ✓ in the panel, or **Resolve** in the comment box.
Resolved comments disappear from the page — no pin, no badge count — and are
**left out of exports**, so an agent is never asked to redo finished work.

They aren't deleted. The **Resolved (n)** button next to *Clear all* switches the
panel to the resolved list, where ↩ reopens a comment and ✕ deletes it for good.

## What gets exported

Per comment: a verified-unique CSS selector, a readable DOM path, the element's
text and HTML, the enclosing landmark and its heading, sibling position, size and
position, and the non-default computed styles.

```markdown
## 1. Make this button green and a bit larger than the other two.

- **Element:** `<button class="btn btn-primary">`
- **Selector:** `div.card:nth-of-type(3) > button.btn.btn-primary`
- **DOM path:** `body > div#root > main > section.pricing > div.grid > div.card > button.btn.btn-primary`
- **Text:** "Choose"
- **Location:** in `<section class="pricing">` — nearest heading: "Team"
- **Position:** child 3 of 3 · 148 × 44 at (612, 430)
- **Key styles:** `display: inline-block; padding: 8px 14px; border-radius: 6px`
```

Three decisions drive the quality of that payload:

- **Generated class names are rejected.** `css-1a2b3c4`, `sc-bdVaJa`, `kXhFjL`,
  `Button_root__x7f3a` and Tailwind arbitrary values change between builds, so a
  selector built on them is dead on arrival. See `isStableClass` in `src/content/capture.ts`.
- **Selectors keep a greppable anchor.** A chain of bare tags (`div > div > span`)
  can be unique yet tells an agent nothing, so the builder keeps walking for a named
  ancestor rather than settling for the first unique result.
- **Headings are scoped to their own landmark.** A heading borrowed from an earlier,
  unrelated section reads as authoritative and sends the agent to the wrong file, so
  it's omitted rather than guessed.

## Develop

```bash
npm run dev      # watching build
npm run check    # typecheck + tests + production build
npm test         # selector, class-name and export-filtering checks
npm run package  # build agentivision.zip
```

`test/fixture.html` is a deliberately hostile page — repeated identical markup,
framework hash classes, Tailwind arbitrary values, deep anonymous nesting. Serve it
and annotate it by hand to exercise the extension:

```bash
npm run fixture   # then open http://localhost:8731/fixture.html
```

Because it's on localhost, the floating button appears automatically.

`node test/sample-export.mjs` prints a complete export built from that fixture —
use it to review the exact payload after changing `capture.ts` or `export.ts`.

### Releasing

Bump the version in **both** `package.json` and `manifest.json` (the package step
fails if they disagree), then push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow builds, tests, packages and publishes the zip.

## Known limitations

- **Iframes aren't supported** (`all_frames: false`). Elements inside an iframe
  can't be selected.
- Selectors are captured against the page as it was. Heavily dynamic lists may
  re-anchor to a different item after a data change; such pins are flagged stale
  only when the selector resolves to nothing at all.
- Pages the browser blocks content scripts on (`chrome://`, `arc://`, the Web
  Store, PDF viewer) can't be annotated.

## License

MIT — see [LICENSE](LICENSE).
