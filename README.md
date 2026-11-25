# JSON Studio

A Harness Web-UI plugin that formats JSON — and anything that merely *looks* like
JSON — with a tolerant parser, three ways to inspect the result, and OCR for
screenshots.

![panel](docs/panel.png)

## What it does

- **Tolerant formatting.** Strict JSON is fast-pathed. JSON5, JS object literals,
  Python dicts, NDJSON, JSONP, escaped JSON strings, fenced snippets, HTTP
  responses with headers, comments, single quotes, unquoted keys, trailing commas,
  `=` separators, missing commas, hex/`.5`/`+1` numbers, `True/False/None`, tuples,
  bare-word values and truncated input are accepted or repaired. The exact repairs
  are listed as chips above the result.
- **Always presentable.** When nothing can be parsed, the input is still laid out
  by indentation and bracket depth, with syntax colouring and the exact error line
  highlighted — never a blank box or a raw dump.
- **Three views.** Highlighted code with line numbers, a collapsible tree with
  per-node path copy, and a table for arrays of flat objects.
- **Image → text.** Drop, paste or pick a screenshot; the host OCRs it with a
  vendored `tesseract.js` model (English, optionally Chinese + English), puts the
  text in the editor and formats it. The recognized text is fully editable, and a
  one-click undo restores the previous draft.
- **Practical extras.** Minify, sort keys recursively, escape/unescape a JSON
  string, copy, download, line wrapping, live character/byte/line/node/depth
  counters, parse timing, and a draft that survives panel switches.
- **Selection shortcut.** Select JSON anywhere in the Harness (chat, an editor, a
  tool result — or inside the composer) and press **Ctrl+Alt+J** (⌘ also works).
  The panel opens with exactly that text; with nothing selected it simply opens.
  The shortcut is configurable — record any combination in
  **Settings → JSON Studio** — and is shown in the panel footer/empty state.
- **Bilingual UI.** Chinese and English, following the Harness locale.

> The shortcut is an **in-app** global key binding (it works wherever the focus is
> inside the Harness window). It is not registered as an OS-wide hotkey, because a
> web plugin has no access to Electron's global shortcut API.

## Install

From this directory, with the Harness running:

```text
plugin_manager install_bundle target=E:\selfwork\json-studio
```

The bundle installs its `tesseract.js` dependency. Its OCR models are committed
under `assets/lang/` and are **not** downloaded at runtime. OCR runs in a child
process started with the system `node` binary (the Harness Host's filesystem view
cannot read a workspace plugin's `node_modules`), so `node` must be on `PATH` (or
set `JSON_STUDIO_NODE` to an absolute binary).

Then open **JSON Studio** from the icon strip on the left sidebar.

## Configuration

The patch row accepts:

| Key | Default | Meaning |
| --- | --- | --- |
| `maxImageBytes` | `12582912` | Largest accepted image |
| `ocrLangs` | `eng` | Default OCR language set (`eng`, `chi_sim`, `eng+chi_sim`) |
| `shortcut` | `Ctrl+Alt+J` | Default in-app shortcut; a shortcut recorded in Settings overrides it |
| `watchClientBundle` | `true` | Rebuild the browser half on `client.js` edits |
| `clientPollMs` | `300` | Watch poll interval |
| `devLab` | `false` | Serve `/json-studio/lab`, a local harness that mounts the real panel outside the shell (used for UI verification) |

## Development

- `src/engine.js` — the tolerant analyzer. Pure ESM, no DOM, tested with
  `node --test test/engine.test.mjs`.
- `src/ocr.js` — the host OCR engine (one serialized `tesseract.js` worker).
- `src/ui.js` — the React panel in plain `h()` calls.
- `build.mjs` — wraps `src/engine.js` in a scope and inlines it with `src/ui.js`
  into the shipped `client.js`. Rebuild with `node build.mjs --check`.

The host watch (`watchClientBundle`) publishes the rebuilt bundle through
`clientModules.rebuilt()`, so editing `client.js` reaches an open page without a
Harness restart.

## Settings

**Settings → JSON Studio** records the selection shortcut. Press *Record*, press a
combination that includes Ctrl/⌘ or Alt, and it takes effect immediately for this
profile; *Reset* restores the configured default. A recorded shortcut is stored in
`localStorage` (so it does not rewrite your patch file); the patch value remains
the fallback shown in the panel.

![settings](docs/settings.png)

## Verification

- `node --test test/engine.test.mjs` — 21 tests over the parser matrix.
- `node --test test/engine.contract.test.mjs` — 76 independent contract tests.
- `node --test test/ocr.test.mjs` — 10 tests; measured on committed fixtures:
  clean screenshot 85% conf / 0.7% CER, IDE screenshot 86% / 0.9%, Chinese+JSON
  90% / 25.3% (all keys hit), 600 px low-res 81% / 0.7%.
  All three files: **107 tests, 107 passing**.
- The panel was mounted with the real `client.js` in a local harness
  (`devLab: true`) in dark and light themes: code/tree/table views, repair chips,
  fallback error banner, and the full image→OCR→format flow were exercised there.
  The Settings page was exercised the same way: recording `Ctrl+Shift+K` updated
  the stored shortcut, the panel footer and the live global handler; Reset
  restored `Ctrl+Alt+J`.
  The real Harness client registered `json-studio` under `main`,
  `sidebar.panellist` and `settings.section` (inspected live), which is the
  shell-level integration check; a screenshot of the actual Harness window was
  not possible because the desktop's Web channel requires its session credential.

## Handoff for a no-OCR reimplementation

[DEVELOPMENT.md](DEVELOPMENT.md) is a self-contained build specification for
another agent: platform contracts, engine behavior, UI/shortcut rules, the
build/install/verification flow, and the exact list of OCR pieces to delete.
It targets a version without image recognition.

## Limits

- OCR quality depends on the screenshot: small text, heavy anti-aliasing and
  mixed scripts degrade it. The result is always editable, and parsing repairs
  most cosmetic OCR damage.
- OCR is CPU-bound and runs on the host; expect ~0.2 s for a small screenshot and
  a few seconds for a 4K one. Calls are serialized behind one worker.
- Very large inputs are bounded (4 MB analyzed, first 4,000 lines rendered,
  2,000 table rows) so the panel stays responsive.

## License

Plugin code: MIT. OCR runtime: `tesseract.js` (Apache-2.0) and
`tessdata` models (Apache-2.0).
