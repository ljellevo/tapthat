# Page feedback — 3 comments

- **Page:** http://localhost:3000/pricing — "TapThat selector fixture"
- **Captured:** 2025-01-01T00:00:00.000Z
- **Viewport:** 1024 × 768

Each item below is a change request attached to a specific element on the page above.
Use the selector, DOM path, nearest heading and HTML snippet to locate the matching source in
this repo — searching for the text content, class names, or data attributes is usually fastest —
then apply the requested change. If an element cannot be located with confidence, say so rather
than guessing at a different one.

---
## 1. Make this button green and a bit larger than the other two.

- **Element:** `<button class="btn btn-primary">`
- **Selector:** `div.card:nth-of-type(3) > button.btn.btn-primary`
- **DOM path:** `body > div#root > main > section.pricing > div.grid > div.card > button.btn.btn-primary`
- **Text:** "Choose"
- **Location:** in `<section class="pricing">` — nearest heading: "Team"
- **Position:** child 3 of 3 · 0 × 0 at (0, 0)
- **Key styles:** `display: inline-block; color: rgb(0, 0, 0); font-size: 16px; font-family: system-ui, sans-serif; padding: 8px 14px; border-radius: 6px; border: 1px solid rgb(204, 204, 204); text-align: center`

```html
<button class="btn btn-primary">Choose</button>
```

---

## 2. Shorten this to one line and drop the period.

- **Element:** `<p class="lede">`
- **Selector:** `p.lede`
- **DOM path:** `body > div#root > main > section.hero > p.lede`
- **Text:** "Ship your app in days, not months."
- **Location:** in `<section class="hero">` — nearest heading: "Build faster"
- **Position:** child 2 of 3 · 0 × 0 at (0, 0)
- **Key styles:** `display: block; color: rgb(0, 0, 0); font-size: 16px; font-family: system-ui, sans-serif`

```html
<p class="lede">Ship your app in days, not months.</p>
```

---

## 3. Add inline validation and an error state below the field.

- **Element:** `<input type="email" name="email" placeholder="you@example.com">`
- **Selector:** `input[name="email"]`
- **DOM path:** `body > div#root > main > form.signup > input`
- **Location:** in `<form class="signup">`
- **Position:** child 1 of 3 · 0 × 0 at (0, 0)
- **Key styles:** `display: inline-block; color: rgb(0, 0, 0); font-size: 16px; font-family: system-ui, sans-serif`

```html
<input type="email" name="email" placeholder="you@example.com">
```
