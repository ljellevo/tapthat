# Contributing

Thanks for taking a look. This is a small, focused tool — the goal is to make
visual feedback on a live page land accurately in a coding agent's hands.

## Setup

```bash
npm install
npm run dev     # watching build
```

Load the repo folder unpacked at `chrome://extensions` or `arc://extensions` with
Developer mode on, and hit the reload icon on the extension card after each rebuild.

## Before opening a PR

```bash
npm run check
```

That runs the typecheck, the tests and a production build — the same thing CI runs.

## Testing changes to capture or export

`src/content/capture.ts` decides whether an agent can actually find the code a
comment refers to, so it's the part most worth guarding.

```bash
npm test                        # selector uniqueness, class heuristics, export filtering
node test/sample-export.mjs     # print a full export from the fixture
npm run fixture                 # serve test/fixture.html to annotate by hand
```

`test/fixture.html` is intentionally hostile: repeated identical markup, framework
hash classes, Tailwind arbitrary values, deep anonymous nesting. If you add a case
that breaks selector building, add it there.

Two invariants the tests enforce, worth keeping in mind:

- Every selector must be **unique and round-trip** to the element it came from.
- Resolved comments must **never** appear in an export.

The real acceptance test is still manual: export some comments, paste them into an
agent pointed at the app's repo, and see whether it finds the right files without
asking follow-up questions. If it has to ask "which button?", the fix belongs in
`capture.ts`.

## Scope

Changes that make the exported context more accurate, or the picking experience
smoother, are very welcome. Please open an issue before large architectural changes
— particularly anything adding a build-time dependency on a specific framework, or
requiring a local server, since the extension deliberately works on any page with
no setup.
