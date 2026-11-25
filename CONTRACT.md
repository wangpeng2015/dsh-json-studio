# json-studio build contract

The plugin is authored by hand in this workspace and installed into the `desktop`
profile. Two independent modules are built here; the rest is the Lead's.

Rules for both modules:

- Plain ESM, **no imports** and **no build tooling** inside `src/engine.js` and `src/ocr.js`
  (tests may import `node:test`, `node:fs`, etc.).
- Export named functions only. No `export default`, no `export { ... }` lists:
  `build.mjs` inlines `src/engine.js` into the browser bundle by stripping the
  leading `export ` from declarations, so use `export function name() {}` and
  `export const name = ...` only.
- No DOM access in `src/engine.js`. It runs in the browser bundle and under Node
  tests unchanged.
- Keep the public surface listed below; the UI is written against it.

## `src/engine.js` — tolerant JSON analyzer

```js
analyzeJson(text, options?) -> Analysis
```

`options`: `{ maxBytes?: number, maxNodes?: number, maxDepth?: number }`
(defaults: 4_000_000 bytes, 200_000 nodes, 200 depth).

```ts
type Note = { code: string, detail?: string }

type Analysis = {
  ok: boolean,                 // a JS value was recovered (strict, relaxed or repaired)
  mode: 'strict' | 'relaxed' | 'repaired' | 'fallback',
  value?: any,                 // present when ok
  formatted: string,           // pretty JSON when ok; best-effort pretty text when !ok
  notes: Note[],               // deduped, in discovery order
  error: null | { message: string, offset: number, line: number, column: number },
  stats: {
    bytes: number, chars: number, lines: number,
    nodes: number, depth: number, keys: number,
    arrays: number, objects: number
  },
  candidates: Array<{ kind: 'object' | 'array' | 'string' | 'number' | 'literal', start: number, end: number, preview: string }>,
  truncated: boolean
}
```

Pipeline:

1. Normalize: strip UTF-8 BOM, normalize CRLF, replace smart quotes `“ ” ‘ ’`
   outside strings with `" ' ' "` (record `smart-quotes`), strip zero-width chars.
2. `findJsonCandidates(text)`: locate balanced `{...}` / `[...]` / quoted strings /
   bare scalars (numbers, `true/false/null`), skipping fenced code blocks' fences
   themselves. If exactly one candidate and it spans (nearly) the whole trimmed
   text → parse it. If several candidates → parse each; if at least one succeeds,
   use a single one when only one succeeds, otherwise wrap the successfully parsed
   values in an array and record `multiple-values`. (NDJSON and "prose around JSON"
   are the two cases this covers.)
3. Strict pass: `JSON.parse(trimmed)`. If it succeeds → `mode: 'strict'`, no notes.
4. Loose pass: a hand-written tolerant recursive-descent parser (do **not** rely on
   regex-only rewriting; strings/comments must not be corrupted). Accept:
   - `//` and `/* */` comments (`comments`)
   - single-quoted and backtick strings (`single-quotes`)
   - unquoted identifiers as object keys (`unquoted-key`)
   - trailing commas (`trailing-comma`)
   - Python literals `True/False/None` and JS `undefined/NaN/Infinity/-Infinity`,
     `nil` (`python-literals` / `non-finite`)
   - numbers: hex `0x1F`, leading `+`, `.5`, `1.`, `1e3`, `1_000` (`loose-number`)
   - `=` as a key/value separator inside objects (`equals-colon`)
   - missing commas between members/elements when the next token can start a new
     one (`missing-comma`)
   - bareword values (`status: OK`, `msg: hello world`) → trimmed string
     (`bareword-value`); stop at `,` `}` `]` newline or `;`
   - `(...)` treated as an array (`tuple-array`)
   - `;` statement terminators (`semicolon`)
   - trailing garbage after a complete value (`trailing-garbage`)
   - JSONP / wrapper call `foo({...})` (`jsonp-wrapper`)
   - an escaped string that contains JSON, e.g. `"{\"a\":1}"` → unwrap once
     (`escaped-string`)
   - `HTTP/1.1 200 OK` + headers before the body (`header-footer`)
   - code fences ```` ```json ```` (`strip-fence`), prose prefix/suffix
     (`strip-prose`)
   - duplicate keys: last wins, `duplicate-key`
   When the loose pass succeeds: `mode` is `'relaxed'` for purely lexical fixes
   (comments, quotes, literals, numbers, commas, fences) and `'repaired'` when
   structure had to be invented (missing commas, bareword values, truncation
   recovery, `=` separators). Record whether any structural repair happened.
5. Truncation recovery: unbalanced opening bracket/brace at EOF, or a truncated
   value, should still yield the partial value with a `truncated-input` note and
   `truncated: true`. Only do this when the partial value is unambiguous.
6. On unrecoverable input: `ok: false`, `mode: 'fallback'`, `value: undefined`,
   `error` filled (offset/line/column, 1-based line and column), `formatted` is
   `prettyLoose(text)` (see below). Never throw.
7. Bound work: `maxBytes` → truncate with `input-too-large`; node/depth bounds →
   `too-many-nodes` / `too-deep`. Always return.

Additional exports:

- `findJsonCandidates(text, options?) -> Array<{start,end,text,kind}>` — free function.
- `prettyLoose(text) -> string` — indent a stream of JSON-ish tokens by
  `{ [ (` depth, putting a newline after `{`, `[`, `,`, `:`, and before `}`, `]`;
  keep unparseable content (comments, bare words) intact; never throw; empty input
  → `''`. Used when `ok: false`, so it must look tidy even for garbage.
- `tokenizeJson(text) -> Array<{ type, value, start, end }>` where `type` is
  `'key' | 'string' | 'number' | 'literal' | 'punct' | 'comment' | 'bare' | 'space' | 'newline' | 'invalid'`.
  A string immediately followed by `:` (after whitespace) is `key`. This drives
  syntax highlighting for both the parsed result and the fallback text.
- `formatValue(value, indent = 2) -> string` (JSON.stringify, never throws for
  cycles — replace cycles with `"[Circular]"`).
- `minifyValue(value) -> string`.
- `sortKeysDeep(value) -> any` — new value, object keys ascending (localeCompare),
  arrays keep order.
- `escapeJsonString(text) -> string` — JSON string literal body including quotes.
- `unescapeJsonString(text) -> string` — accept `"..."` literal or raw escaped body;
  on bad escape return the input.
- `summarizeValue(value) -> stats` (same stats shape as `Analysis.stats`).

Note codes used by the UI — keep these exact strings, add new ones only when
needed (the UI has a fallback label for unknown codes):
`bom, smart-quotes, zero-width, strip-fence, strip-prose, header-footer, comments,
single-quotes, unquoted-key, trailing-comma, python-literals, non-finite,
loose-number, equals-colon, missing-comma, bareword-value, tuple-array, semicolon,
trailing-garbage, jsonp-wrapper, escaped-string, duplicate-key, multiple-values,
truncated-input, input-too-large, too-many-nodes, too-deep, empty-input,
unbalanced-brackets, unexpected-token`.

Tests (`test/engine.test.mjs`, `node --test`):

- Strict JSON object, array, nested, scalar, unicode/emoji, escaped content.
- Every acceptance bullet above, with expected `mode`, notes and value.
- A table of "must not throw" garbage inputs: `''`, `'   '`, `'{'`, `'}{'`,
  `'hello world'`, `'<!doctype html>'`, `'null null null'`, huge string,
  `'{"a":'`, a 300-deep array, a 1 MB number list.
- `prettyLoose` output sanity: balanced-ish, preserves all string content,
  idempotent on already pretty JSON.
- `tokenizeJson` keeps offsets/reconstruction: concatenating token values returns
  the input exactly.
- `formatValue` cycle safety, `sortKeysDeep` purity, escape/unescape round-trip.

Acceptance: `node --test test/engine.test.mjs` passes, and all of
`test/cases/*.json` (if any) behave as annotated.

## `src/ocr.js` — host-side OCR engine

```js
createOcrEngine({ langDir, defaultLangs = 'eng', nodePath?, logger? }) -> {
  recognize(input: { base64: string, mime?: string, langs?: string }) -> Promise<{
    text: string, confidence: number, langs: string, ms: number, width?: number, height?: number
  }>,
  describe() -> { ready, engine, langs, langFiles, node, pid },
  dispose() -> Promise<void>
}
```

- `tesseract.js@5.1.1` is a real dependency of the package, loaded by the worker
  process (`src/ocr-worker.mjs`) with the **system `node`** binary: the Harness Host
  runs under a filesystem view that cannot read this package's `node_modules`.
  `src/ocr.js` validates inputs, serializes requests over JSON lines, enforces a
  120 s timeout, recycles the child on failure, and kills it on `dispose()`.
- Command/payload protocol: `{ id, base64, langs }` → `{ id, ok, text, confidence,
  langs, ms }` or `{ id, ok: false, error: { code, message } }`; `{ command: 'dispose' }`.
- Traineddata is vendored: `assets/lang/eng.traineddata.gz` and
  `assets/lang/chi_sim.traineddata.gz`. The worker uses `langPath: langDir`,
  `gzip: true` and a temp `cachePath`; never fetch from the network at runtime.
- One worker, lazily created, serialized, reused; `langs` changes call
  `worker.reinitialize(langs)`; page-segmentation mode `6` and
  `preserve_interword_spaces=1` are applied after init and re-applied after a switch.
- Decode `base64` (accept a `data:` URL or bare base64) to a `Buffer`; validate
  magic bytes and `mime` among png/jpeg/webp/gif; reject other input with a
  descriptive `Error` carrying an `OCR_*` code.
- `describe()` never starts the worker.
- Tests (`test/ocr.test.mjs`): committed `test/fixtures/ocr/*.png` images; assert
  recognized text contains expected keys, `ms > 0`, `confidence > 50`; skip
  gracefully when traineddata is absent.

Acceptance: `node --test test/ocr.test.mjs` passes; report accuracy/time for at
least: a clean 900x420 JSON screenshot, a 1920x1080 IDE screenshot, a Chinese+JSON
screenshot, and a low-resolution (600px wide) screenshot.

## Integration points (Lead's files, do not edit)

- `index.js` imports `createOcrEngine` from `./src/ocr.js` and exposes
  `GET /json-studio/status` (including the configured `shortcut`) and
  `POST /json-studio/ocr`.
- The client registers an in-app `keydown` shortcut (`Ctrl+Alt+J` by default,
  `config.shortcut`): a non-empty selection is handed to the panel through
  localStorage + a `json-studio:inject` window event, then `layout.selectPanel`
  opens `main`/`json-studio`; an empty selection just opens the panel.
- `build.mjs` inlines `src/engine.js` and `src/ui.js` into `client.js`.
- `src/ui.js` calls `analyzeJson`, `tokenizeJson`, `prettyLoose`, `formatValue`,
  `minifyValue`, `sortKeysDeep`, `escapeJsonString`, `unescapeJsonString`.
