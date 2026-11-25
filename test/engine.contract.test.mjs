/**
 * INDEPENDENT CONTRACT ACCEPTANCE SUITE for src/engine.js.
 *
 * This file is a verifier, not a mirror of `engine.test.mjs`. Every assertion is
 * derived from CONTRACT.md's "`src/engine.js` — tolerant JSON analyzer" section.
 * Tests whose names start with "GAP:" encode a literal contract expectation that
 * the current implementation does not meet; they are left red on purpose so the
 * engine owner can see the exact input and the expected vs actual behaviour.
 *
 * Run: node --test test/engine.contract.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as engine from '../src/engine.js'

const {
  analyzeJson,
  findJsonCandidates,
  prettyLoose,
  tokenizeJson,
  formatValue,
  minifyValue,
  sortKeysDeep,
  escapeJsonString,
  unescapeJsonString,
  summarizeValue,
} = engine

const codes = (analysis) => analysis.notes.map((note) => note.code)
const hasCode = (analysis, code) => codes(analysis).includes(code)
const MODES = ['strict', 'relaxed', 'repaired', 'fallback']
const KIND_UNION = ['object', 'array', 'string', 'number', 'literal']
const NOTE_CODES = new Set([
  'bom', 'smart-quotes', 'strip-fence', 'strip-prose', 'header-footer', 'comments',
  'single-quotes', 'unquoted-key', 'trailing-comma', 'python-literals', 'non-finite',
  'loose-number', 'equals-colon', 'missing-comma', 'bareword-value', 'tuple-array',
  'semicolon', 'trailing-garbage', 'jsonp-wrapper', 'escaped-string', 'duplicate-key',
  'multiple-values', 'truncated-input', 'input-too-large', 'too-many-nodes', 'too-deep',
  'empty-input', 'unbalanced-brackets', 'unexpected-token',
])

/** @returns 1-based line/column for a source offset, independently of the engine. */
function lineColAt(text, offset) {
  const limit = Math.max(0, Math.min(offset, text.length))
  let line = 1
  let column = 1
  for (let index = 0; index < limit; index += 1) {
    if (text[index] === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { line, column }
}

/* ------------------------------------------------------------------ surface */

test('contract: engine.js has no imports and only leading named exports', () => {
  const source = readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8')
  assert.equal(/^\s*import\s/m.test(source), false, 'engine.js must not import anything')
  assert.equal(/\bexport\s+default\b/.test(source), false, 'engine.js must not export default')
  assert.equal(/\bexport\s*\{/.test(source), false, 'engine.js must not use an export list')
  const exportLines = source.split('\n').filter((line) => /^\s*export\b/.test(line))
  assert.ok(exportLines.length > 0, 'engine.js must export something')
  for (const line of exportLines) {
    assert.match(line, /^\s*export\s+(?:function|const|class)\s/, `unexpected export form: ${line}`)
  }
})

test('contract: public surface is exactly the documented named functions', () => {
  const expected = [
    'analyzeJson', 'findJsonCandidates', 'prettyLoose', 'tokenizeJson',
    'formatValue', 'minifyValue', 'sortKeysDeep', 'escapeJsonString',
    'unescapeJsonString', 'summarizeValue',
  ]
  for (const name of expected) {
    assert.equal(typeof engine[name], 'function', `missing export ${name}`)
  }
  assert.equal('default' in engine, false, 'no default export allowed')
})

/* --------------------------------------------------------- strict JSON pass */

const strictCases = [
  ['object', '{"a":1,"b":[true,null,"x"],"c":{"d":2}}', { a: 1, b: [true, null, 'x'], c: { d: 2 } }],
  ['empty object', '{}', {}],
  ['array', '[1,2,3]', [1, 2, 3]],
  ['empty array', '[]', []],
  ['nested', '{"a":[{"b":[{"c":1}]}]}', { a: [{ b: [{ c: 1 }] }] }],
  ['scalar number', '42', 42],
  ['scalar float', '-1.5e3', -1500],
  ['scalar true', 'true', true],
  ['scalar null', 'null', null],
  ['scalar string', '"hello"', 'hello'],
  ['whitespace', '\n\t  {"a": 1} \r\n', { a: 1 }],
  ['unicode and emoji', '{"emoji":"😀","中文":"值"}', { emoji: '😀', 中文: '值' }],
  ['escaped content', String.raw`{"s":"a\nb\t\"c\"\\d"}`, { s: 'a\nb\t"c"\\d' }],
]

for (const [name, input, expected] of strictCases) {
  test(`strict: ${name}`, () => {
    const analysis = analyzeJson(input)
    assert.equal(analysis.ok, true, `ok for ${JSON.stringify(input)}`)
    assert.equal(analysis.mode, 'strict', `mode for ${JSON.stringify(input)}`)
    assert.deepEqual(analysis.value, expected)
    assert.deepEqual(codes(analysis), [], 'strict pass on normalized text takes no loose notes')
    assert.equal(analysis.error, null)
    assert.equal(analysis.truncated, false)
    assert.equal(typeof analysis.formatted, 'string')
  })
}

test('strict: duplicate object keys are last-wins and stay silent under strict', () => {
  const analysis = analyzeJson('{"a":1,"a":2}')
  assert.equal(analysis.mode, 'strict')
  assert.deepEqual(analysis.value, { a: 2 })
  assert.deepEqual(codes(analysis), [])
})

/* ---------------------------------------------------------- normalization */

test('normalization: UTF-8 BOM is stripped and recorded', () => {
  const analysis = analyzeJson('\ufeff{"a":1}')
  assert.equal(analysis.ok, true)
  assert.deepEqual(analysis.value, { a: 1 })
  assert.ok(hasCode(analysis, 'bom'), `expected bom, got ${JSON.stringify(codes(analysis))}`)
})

test('normalization: CRLF line endings parse as strict JSON', () => {
  const analysis = analyzeJson('{\r\n"a": 1\r\n}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'strict')
  assert.deepEqual(analysis.value, { a: 1 })
})

test('normalization: smart quotes outside strings are replaced and recorded', () => {
  const analysis = analyzeJson('{\u201ca\u201d: 1, \u2018b\u2019: 2}')
  assert.equal(analysis.ok, true)
  assert.deepEqual(analysis.value, { a: 1, b: 2 })
  assert.ok(hasCode(analysis, 'smart-quotes'), `expected smart-quotes, got ${JSON.stringify(codes(analysis))}`)
})

test('GAP: normalize strips zero-width characters (pipeline step 1)', () => {
  const input = '{\u200b"a":\u200b1}'
  const analysis = analyzeJson(input)
  assert.equal(analysis.ok, true, `expected zero-width characters to be stripped, got mode=${analysis.mode} notes=${JSON.stringify(codes(analysis))} error=${JSON.stringify(analysis.error)}`)
  assert.deepEqual(analysis.value, { a: 1 })
})

test('normalization: zero-width characters around a JSON document do not break it', () => {
  const analysis = analyzeJson('\u200b{"a":1}\u200b')
  assert.equal(analysis.ok, true)
  assert.deepEqual(analysis.value, { a: 1 })
})

test('GAP: smart quotes inside a JSON string are left untouched (outside-strings rule)', () => {
  const input = '{"q":"it\u2019s",}'
  const analysis = analyzeJson(input)
  assert.equal(analysis.ok, true)
  assert.equal(analysis.value.q, 'it\u2019s', `string content was rewritten to ${JSON.stringify(analysis.value.q)}`)
})

/* ------------------------------------------------------------- loose pass */

test('loose: // and /* */ comments are accepted and recorded once', () => {
  const analysis = analyzeJson('{\n // line\n /* block */\n "a": 1\n}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { a: 1 })
  assert.equal(codes(analysis).filter((code) => code === 'comments').length, 1, 'comments note is deduped')
})

test('loose: single-quoted and backtick strings are accepted', () => {
  const analysis = analyzeJson("{'a': 'b', `c`: `d`}")
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { a: 'b', c: 'd' })
  assert.ok(hasCode(analysis, 'single-quotes'))
})

test('loose: unquoted identifiers are accepted as object keys', () => {
  const analysis = analyzeJson('{a: 1, b_2: 2, $c: 3}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { a: 1, b_2: 2, $c: 3 })
  assert.ok(hasCode(analysis, 'unquoted-key'))
})

test('loose: trailing commas in objects and arrays are accepted', () => {
  for (const input of ['{"a":1,}', '[1,2,]']) {
    const analysis = analyzeJson(input)
    assert.equal(analysis.ok, true, `ok for ${input}`)
    assert.equal(analysis.mode, 'relaxed', `mode for ${input}`)
    assert.ok(hasCode(analysis, 'trailing-comma'), `trailing-comma for ${input}, got ${JSON.stringify(codes(analysis))}`)
  }
})

test('loose: Python literals map to JSON values with python-literals', () => {
  const analysis = analyzeJson('{"a": True, "b": False, "c": None, "d": nil}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { a: true, b: false, c: null, d: null })
  assert.ok(hasCode(analysis, 'python-literals'))
})

test('loose: JS non-finite literals are accepted with non-finite', () => {
  const analysis = analyzeJson('{"nan": NaN, "inf": Infinity, "ninf": -Infinity, "u": undefined}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.ok(Object.is(analysis.value.nan, NaN), 'NaN literal should decode to NaN')
  assert.equal(analysis.value.inf, Infinity)
  assert.equal(analysis.value.ninf, -Infinity)
  // The contract names the token but does not pin undefined's decoded value.
  assert.ok(analysis.value.u === null || analysis.value.u === undefined, 'undefined literal is nullish')
  assert.ok(hasCode(analysis, 'non-finite'), `expected non-finite, got ${JSON.stringify(codes(analysis))}`)
})

test('loose: hex, leading +, leading dot, trailing dot and underscored numbers', () => {
  const analysis = analyzeJson('{a: 0x1F, b: +2, c: .5, d: 1., e: 1e3, f: 1_000}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { a: 31, b: 2, c: 0.5, d: 1, e: 1000, f: 1000 })
  assert.ok(hasCode(analysis, 'loose-number'))
})

test('loose: = is accepted as a key/value separator and is a repair', () => {
  const analysis = analyzeJson('{a = 1}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'repaired')
  assert.deepEqual(analysis.value, { a: 1 })
  assert.ok(hasCode(analysis, 'equals-colon'))
})

test('loose: missing commas between members and elements are repaired', () => {
  for (const [input, expected] of [
    ['{"a": 1 "b": 2}', { a: 1, b: 2 }],
    ['[1 2 3]', [1, 2, 3]],
  ]) {
    const analysis = analyzeJson(input)
    assert.equal(analysis.ok, true, `ok for ${input}`)
    assert.equal(analysis.mode, 'repaired', `mode for ${input}`)
    assert.deepEqual(analysis.value, expected)
    assert.ok(hasCode(analysis, 'missing-comma'), `missing-comma for ${input}, got ${JSON.stringify(codes(analysis))}`)
  }
})

test('loose: bareword values become trimmed strings and are a repair', () => {
  const analysis = analyzeJson('{status: OK, msg: hello world}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'repaired')
  assert.deepEqual(analysis.value, { status: 'OK', msg: 'hello world' })
  assert.ok(hasCode(analysis, 'bareword-value'))
})

test('loose: (...) is treated as an array and is a repair', () => {
  const analysis = analyzeJson('(1, 2, 3)')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'repaired')
  assert.deepEqual(analysis.value, [1, 2, 3])
  assert.ok(hasCode(analysis, 'tuple-array'))
})

test('loose: ; statement terminators are accepted', () => {
  const analysis = analyzeJson('{"a": 1; "b": 2}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { a: 1, b: 2 })
  assert.ok(hasCode(analysis, 'semicolon'))
})

test('loose: trailing garbage after a complete value is noted', () => {
  const analysis = analyzeJson('{"a":1} baz')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { a: 1 })
  assert.ok(hasCode(analysis, 'trailing-garbage'), `expected trailing-garbage, got ${JSON.stringify(codes(analysis))}`)
})

test('loose: JSONP wrapper calls are unwrapped', () => {
  for (const [input, expected] of [
    ['callback({"a":1});', { a: 1 }],
    ['foo([1,2])', [1, 2]],
  ]) {
    const analysis = analyzeJson(input)
    assert.equal(analysis.ok, true, `ok for ${input}`)
    assert.equal(analysis.mode, 'relaxed', `mode for ${input}`)
    assert.deepEqual(analysis.value, expected)
    assert.ok(hasCode(analysis, 'jsonp-wrapper'), `jsonp-wrapper for ${input}, got ${JSON.stringify(codes(analysis))}`)
  }
})

test('loose: an escaped JSON string is unwrapped exactly once', () => {
  const object = analyzeJson('"{\\"a\\":1}"')
  assert.equal(object.ok, true)
  assert.equal(object.mode, 'relaxed')
  assert.deepEqual(object.value, { a: 1 })
  assert.ok(hasCode(object, 'escaped-string'))

  const array = analyzeJson('"[1,2]"')
  assert.equal(array.ok, true)
  assert.deepEqual(array.value, [1, 2])
  assert.ok(hasCode(array, 'escaped-string'))
})

test('loose: HTTP/1.1 status line plus headers before the body are stripped', () => {
  const analysis = analyzeJson('HTTP/1.1 200 OK\nContent-Type: application/json\nDate: now\n\n{"a": 1}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { a: 1 })
  assert.ok(hasCode(analysis, 'header-footer'), `expected header-footer, got ${JSON.stringify(codes(analysis))}`)
})

test('GAP: header block without the separating blank line is still header-footer', () => {
  const input = 'HTTP/1.1 200 OK\nContent-Type: application/json\n{"a": 1}'
  const analysis = analyzeJson(input)
  assert.equal(analysis.ok, true)
  assert.deepEqual(analysis.value, { a: 1 })
  assert.ok(hasCode(analysis, 'header-footer'), `expected header-footer, got ${JSON.stringify(codes(analysis))}`)
})

test('loose: fenced code blocks are stripped and parsable', () => {
  for (const input of [
    '```json\n{"a": 1}\n```',
    'Here you go:\n```json\n{"a": 1}\n```\nHope it helps',
  ]) {
    const analysis = analyzeJson(input)
    assert.equal(analysis.ok, true, `ok for ${JSON.stringify(input)}`)
    assert.equal(analysis.mode, 'relaxed', `mode for ${JSON.stringify(input)}`)
    assert.deepEqual(analysis.value, { a: 1 })
    assert.ok(hasCode(analysis, 'strip-fence'), `strip-fence for ${JSON.stringify(input)}, got ${JSON.stringify(codes(analysis))}`)
  }
})

test('loose: prose around JSON is stripped and noted', () => {
  const analysis = analyzeJson('The response was {"ok": true, "count": 2} as expected.')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'relaxed')
  assert.deepEqual(analysis.value, { ok: true, count: 2 })
  assert.ok(
    hasCode(analysis, 'strip-prose') || hasCode(analysis, 'trailing-garbage'),
    `expected strip-prose, got ${JSON.stringify(codes(analysis))}`,
  )
})

test('loose: NDJSON values are wrapped in an array with multiple-values', () => {
  const objects = analyzeJson('{"a":1}\n{"b":2}\n{"c":3}')
  assert.equal(objects.ok, true)
  assert.deepEqual(objects.value, [{ a: 1 }, { b: 2 }, { c: 3 }])
  assert.ok(hasCode(objects, 'multiple-values'))

  const scalars = analyzeJson('1\n2\n3')
  assert.equal(scalars.ok, true)
  assert.deepEqual(scalars.value, [1, 2, 3])
  assert.ok(hasCode(scalars, 'multiple-values'))
})

test('GAP: wrapping several top-level values invents structure, so mode is repaired', () => {
  const analysis = analyzeJson('{"a":1}\n{"b":2}')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.mode, 'repaired', `array wrapper is structural, got mode=${analysis.mode} notes=${JSON.stringify(codes(analysis))}`)
})

test('loose: duplicate keys are last-wins and noted', () => {
  const analysis = analyzeJson("{'a': 1, 'a': 2}")
  assert.equal(analysis.ok, true)
  assert.deepEqual(analysis.value, { a: 2 })
  assert.ok(hasCode(analysis, 'duplicate-key'), `expected duplicate-key, got ${JSON.stringify(codes(analysis))}`)
})

/* ----------------------------------------------------------- truncation */

test('truncation: unbalanced brackets at EOF recover the partial value', () => {
  const cases = [
    ['{"a": 1, "b": [1, 2', { a: 1, b: [1, 2] }],
    ['[1, 2,', [1, 2]],
    ['{"a": 1', { a: 1 }],
  ]
  for (const [input, expected] of cases) {
    const analysis = analyzeJson(input)
    assert.equal(analysis.ok, true, `ok for ${input}`)
    assert.deepEqual(analysis.value, expected, `value for ${input}`)
    assert.equal(analysis.truncated, true, `truncated flag for ${input}`)
    assert.ok(hasCode(analysis, 'truncated-input'), `truncated-input for ${input}, got ${JSON.stringify(codes(analysis))}`)
  }
})

test('GAP: truncation recovery is structural, so mode is repaired', () => {
  const rows = []
  for (const input of ['{"a": 1, "b": [1, 2', '[1, 2,', '{"a": 1']) {
    const analysis = analyzeJson(input)
    if (analysis.mode !== 'repaired') rows.push({ input, mode: analysis.mode })
  }
  assert.deepEqual(rows, [], 'CONTRACT.md counts truncation recovery among repaired inputs')
})

/* ------------------------------------------------------------- fallback */

const fallbackCases = ['}{', ':::', '[}', '<!doctype html>', '/* only a comment */', '%%%', ']', '}']

test('fallback: unrecoverable input reports ok=false with error and prettyLoose output', () => {
  for (const input of fallbackCases) {
    const analysis = analyzeJson(input)
    assert.equal(analysis.ok, false, `ok for ${JSON.stringify(input)}`)
    assert.equal(analysis.mode, 'fallback', `mode for ${JSON.stringify(input)}`)
    assert.equal(analysis.value, undefined, `value for ${JSON.stringify(input)}`)
    assert.equal(typeof analysis.formatted, 'string')
    assert.equal(analysis.formatted, prettyLoose(input), `formatted must be prettyLoose(text) for ${JSON.stringify(input)}`)
    assert.ok(analysis.error && typeof analysis.error === 'object', `error filled for ${JSON.stringify(input)}`)
    assert.equal(typeof analysis.error.message, 'string', `error.message for ${JSON.stringify(input)}`)
    assert.equal(typeof analysis.error.offset, 'number', `error.offset for ${JSON.stringify(input)}`)
    assert.ok(analysis.error.offset >= 0 && analysis.error.offset <= input.length, `error.offset in range for ${JSON.stringify(input)}`)
    const expected = lineColAt(input, analysis.error.offset)
    assert.deepEqual(
      { line: analysis.error.line, column: analysis.error.column },
      expected,
      `error line/column must match offset for ${JSON.stringify(input)}`,
    )
    assert.equal(analysis.truncated, false, `truncated flag for ${JSON.stringify(input)}`)
  }
})

test('fallback: line/column are 1-based and point at the failing character', () => {
  const input = '\n\n  }{'
  const analysis = analyzeJson(input)
  assert.equal(analysis.ok, false)
  assert.equal(analysis.error.line, 3, `line for ${JSON.stringify(input)}`)
  assert.equal(analysis.error.column, 3, `column for ${JSON.stringify(input)}`)
  assert.equal(analysis.error.offset, 4, `offset for ${JSON.stringify(input)}`)
})

/* ------------------------------------------------------ never-throw table */

const deepArray = '['.repeat(300) + '1' + ']'.repeat(300)
const hugeString = 'x'.repeat(1_000_000)
const oneMegabyteNumbers = `[${new Array(500_000).fill('1').join(',')}]`

test('never throws: empty, whitespace, broken and huge inputs', () => {
  const garbage = [
    '', '   ', '{', '}{', 'hello world', '<!doctype html>', 'null null null',
    '{"a":', deepArray, hugeString, oneMegabyteNumbers,
  ]
  for (const input of garbage) {
    const label = input.length > 40 ? `<${input.length} chars>` : JSON.stringify(input)
    let analysis
    assert.doesNotThrow(() => { analysis = analyzeJson(input) }, `analyzeJson threw for ${label}`)
    assert.equal(typeof analysis.ok, 'boolean', `ok shape for ${label}`)
    assert.ok(MODES.includes(analysis.mode), `mode for ${label}: ${analysis.mode}`)
    assert.equal(typeof analysis.formatted, 'string', `formatted for ${label}`)
    assert.ok(Array.isArray(analysis.notes), `notes for ${label}`)
    assert.ok(Array.isArray(analysis.candidates), `candidates for ${label}`)
    assert.equal(typeof analysis.truncated, 'boolean', `truncated for ${label}`)
    assert.ok(analysis.stats && typeof analysis.stats.bytes === 'number', `stats for ${label}`)
  }
})

test('never throws: non-string inputs are coerced', () => {
  for (const input of [null, undefined, 42, true, { a: 1 }]) {
    const analysis = analyzeJson(input)
    assert.equal(typeof analysis.ok, 'boolean')
    assert.equal(typeof analysis.formatted, 'string')
  }
})

/* ---------------------------------------------------------------- bounds */

test('bounds: maxBytes truncates and records input-too-large', () => {
  const analysis = analyzeJson('{"a":"0123456789"}', { maxBytes: 10 })
  assert.equal(analysis.truncated, true)
  assert.ok(hasCode(analysis, 'input-too-large'), `expected input-too-large, got ${JSON.stringify(codes(analysis))}`)
})

test('GAP: maxDepth produces a too-deep note instead of being ignored', () => {
  const analysis = analyzeJson(deepArray, { maxDepth: 10 })
  assert.ok(hasCode(analysis, 'too-deep'), `expected too-deep for maxDepth:10, got ${JSON.stringify(codes(analysis))}`)

  const withDefault = analyzeJson(deepArray)
  assert.ok(hasCode(withDefault, 'too-deep'), `300-deep input exceeds the default maxDepth 200, got ${JSON.stringify(codes(withDefault))}`)
})

test('GAP: maxNodes produces a too-many-nodes note instead of being ignored', () => {
  const wide = `[${new Array(100).fill('1').join(',')}]`
  const analysis = analyzeJson(wide, { maxNodes: 10 })
  assert.ok(hasCode(analysis, 'too-many-nodes'), `expected too-many-nodes for maxNodes:10, got ${JSON.stringify(codes(analysis))}`)
})

/* ------------------------------------------------------------ Analysis shape */

test('Analysis: strict result has the documented shape', () => {
  const analysis = analyzeJson('{"a":[1,{"b":2}],"c":"d"}')
  assert.equal(typeof analysis.ok, 'boolean')
  assert.ok(MODES.includes(analysis.mode))
  assert.equal(typeof analysis.formatted, 'string')
  assert.equal(analysis.error, null)
  assert.ok(Array.isArray(analysis.notes))
  assert.ok(Array.isArray(analysis.candidates))
  assert.equal(typeof analysis.truncated, 'boolean')
  const statsKeys = ['bytes', 'chars', 'lines', 'nodes', 'depth', 'keys', 'arrays', 'objects']
  for (const key of statsKeys) {
    assert.equal(typeof analysis.stats[key], 'number', `stats.${key}`)
  }
  assert.equal(analysis.stats.nodes, 6)
  assert.equal(analysis.stats.depth, 4)
  assert.equal(analysis.stats.keys, 3)
  assert.equal(analysis.stats.arrays, 1)
  assert.equal(analysis.stats.objects, 2)
  for (const note of analysis.notes) {
    assert.equal(typeof note.code, 'string')
    assert.ok(NOTE_CODES.has(note.code), `unknown note code ${note.code}`)
  }
  for (const candidate of analysis.candidates) {
    assert.equal(typeof candidate.start, 'number')
    assert.equal(typeof candidate.end, 'number')
    assert.equal(typeof candidate.preview, 'string')
    assert.ok(candidate.end >= candidate.start)
  }
})

test('Analysis: note codes always come from the contract vocabulary', () => {
  const corpus = [
    '\ufeff{"a":1}', '{\u201ca\u201d: 1}', '{"a":1,}', "{'a':1}", '// c\n{"a":1}',
    '{a: 1}', '{a: True}', '{a: NaN}', '{a = 1}', '{"a":1 "b":2}', '{a: OK}',
    '(1,2)', '{"a":1;}', '{"a":1} junk', 'cb({"a":1});', '"{\\"a\\":1}"',
    '{"a":1}', 'HTTP/1.1 200 OK\n\n{"a":1}', '```json\n{"a":1}\n```',
    'prose {"a":1} suffix', '{"a":1}\n{"b":2}', '{"a":1,"a":2}', '[1,2,',
    '', '}{',
  ]
  for (const input of corpus) {
    const analysis = analyzeJson(input)
    for (const note of analysis.notes) {
      assert.ok(NOTE_CODES.has(note.code), `unknown note ${note.code} for ${JSON.stringify(input)}`)
    }
  }
})

test('GAP: Analysis.candidates kinds stay inside the contract union', () => {
  const bad = []
  for (const input of ['true', '42', '"hi"', '{"a":1}', '[1]']) {
    const analysis = analyzeJson(input)
    for (const candidate of analysis.candidates) {
      if (!KIND_UNION.includes(candidate.kind)) bad.push({ input, kind: candidate.kind })
    }
  }
  assert.deepEqual(bad, [], `candidate kinds must be one of ${KIND_UNION.join(', ')}`)
})

/* ------------------------------------------------- findJsonCandidates free */

test('findJsonCandidates: balanced objects/arrays from prose with exact offsets', () => {
  const text = 'prefix {"a": [1, 2, {"b": 3}]} middle [4, 5] suffix'
  const candidates = findJsonCandidates(text)
  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates.map((candidate) => candidate.kind), ['object', 'array'])
  assert.equal(candidates[0].text, '{"a": [1, 2, {"b": 3}]}')
  assert.equal(candidates[1].text, '[4, 5]')
  for (const candidate of candidates) {
    assert.equal(candidate.text, text.slice(candidate.start, candidate.end))
  }
})

test('findJsonCandidates: bare scalars are candidates', () => {
  const kinds = findJsonCandidates('values 42 true null').map((candidate) => candidate.kind)
  assert.deepEqual(kinds, ['number', 'literal', 'literal'])
})

test('GAP: findJsonCandidates skips fenced code block fences', () => {
  const text = '```json\n{"a":1}\n```'
  const candidates = findJsonCandidates(text)
  assert.deepEqual(
    candidates.map((candidate) => candidate.kind),
    ['object'],
    `fence lines must not become string candidates; got ${JSON.stringify(candidates.map((candidate) => `${candidate.kind}:${candidate.text}`))}`,
  )
  assert.equal(candidates[0].text, '{"a":1}')
})

/* -------------------------------------------------------------- tokenize */

const tokenSamples = [
  '{"a":1,"b":[true,null,"x\\n"],"c":{"d":2}}',
  "{\n  // comment\n  bare: 'v',\n  \"n\": .5\n}\n",
  'not json at all <>&',
  '',
  'a\tb\r\nc',
  '"unterminated',
  '```json\n{"a":1}\n```',
  '{"emoji":"😀中文"}',
  'throw \u201csmart\u201d quotes',
]

test('tokenizeJson: concatenating token values rebuilds the input exactly', () => {
  for (const sample of tokenSamples) {
    const tokens = tokenizeJson(sample)
    assert.equal(tokens.map((token) => token.value).join(''), sample, `rebuild for ${JSON.stringify(sample)}`)
  }
})

test('tokenizeJson: offsets are exact, contiguous and inside the input', () => {
  for (const sample of tokenSamples) {
    const tokens = tokenizeJson(sample)
    let cursor = 0
    for (const token of tokens) {
      assert.equal(token.value, sample.slice(token.start, token.end), `value slice for ${JSON.stringify(sample)}`)
      assert.equal(token.start, cursor, `contiguous tokens for ${JSON.stringify(sample)}`)
      assert.ok(Number.isInteger(token.start) && Number.isInteger(token.end))
      cursor = token.end
    }
    assert.equal(cursor, sample.length, `full coverage for ${JSON.stringify(sample)}`)
  }
})

test('tokenizeJson: token types stay inside the documented set', () => {
  const allowed = new Set(['key', 'string', 'number', 'literal', 'punct', 'comment', 'bare', 'space', 'newline', 'invalid'])
  for (const sample of tokenSamples) {
    for (const token of tokenizeJson(sample)) {
      assert.ok(allowed.has(token.type), `token type ${token.type} for ${JSON.stringify(sample)}`)
    }
  }
})

test('tokenizeJson: a string followed by ":" after whitespace is a key', () => {
  const tokens = tokenizeJson('{"a": 1, "b"  : 2}')
  const keys = tokens.filter((token) => token.type === 'key').map((token) => token.value)
  assert.deepEqual(keys, ['"a"', '"b"'])

  const afterNewline = tokenizeJson('{"a"\n: 1}')
  assert.equal(afterNewline.find((token) => token.type === 'key').value, '"a"')
})

/* ------------------------------------------------------------ prettyLoose */

test('prettyLoose: empty input becomes an empty string', () => {
  assert.equal(prettyLoose(''), '')
  assert.equal(prettyLoose('   '), '')
  assert.equal(prettyLoose(undefined), '')
})

test('prettyLoose: breaks and indents parseable JSON with balanced brackets', () => {
  const input = '{"a":1,"b":[1,2,"x y"],}'
  const output = prettyLoose(input)
  assert.match(output, /\n {2}"a": 1,/u)
  assert.match(output, /\n {2}"b": \[/u)
  assert.equal((output.match(/\{/gu) || []).length, (output.match(/\}/gu) || []).length)
  assert.equal((output.match(/\[/gu) || []).length, (output.match(/\]/gu) || []).length)
})

test('prettyLoose: already-pretty JSON is stable', () => {
  const pretty = formatValue({ a: 1, b: [1, 2, { c: 'x y' }] })
  assert.equal(prettyLoose(pretty), pretty)
})

test('prettyLoose: preserves every string and comment token verbatim', () => {
  const input = '{\n  "s": "a b",\n  "t": "it\\"s",\n  "u": "中文",\n  // trailing comment\n}'
  const output = prettyLoose(input)
  for (const token of tokenizeJson(input)) {
    if (token.type === 'string' || token.type === 'comment') {
      assert.ok(output.includes(token.value), `lost token ${token.value} from ${JSON.stringify(input)}`)
    }
  }
})

test('prettyLoose: never throws on garbage', () => {
  for (const input of ['}{', '<!doctype html>', 'hello world', '{"a":', deepArray, hugeString]) {
    let output
    assert.doesNotThrow(() => { output = prettyLoose(input) }, `prettyLoose threw for ${JSON.stringify(input).slice(0, 40)}`)
    assert.equal(typeof output, 'string')
  }
})

/* -------------------------------------------------------- value helpers */

test('formatValue: pretty JSON, custom indent and cycle safety', () => {
  assert.equal(formatValue({ a: 1 }), '{\n  "a": 1\n}')
  assert.equal(formatValue({ a: 1 }, 4), '{\n    "a": 1\n}')
  assert.equal(typeof formatValue(undefined), 'string', 'formatValue never throws for undefined')

  const cyclic = { a: 1 }
  cyclic.self = cyclic
  let text
  assert.doesNotThrow(() => { text = formatValue(cyclic) }, 'formatValue must not throw on cycles')
  assert.match(text, /\[Circular\]/u)
})

test('minifyValue: compact JSON and cycle safety', () => {
  assert.equal(minifyValue({ a: 1, b: [2] }), '{"a":1,"b":[2]}')
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  let text
  assert.doesNotThrow(() => { text = minifyValue(cyclic) }, 'minifyValue must not throw on cycles')
  assert.match(text, /\[Circular\]/u)
})

test('sortKeysDeep: sorted copy, arrays keep order, input untouched', () => {
  const input = { b: 1, a: { d: 2, c: 3 }, list: [3, 1, 2] }
  const sorted = sortKeysDeep(input)
  assert.deepEqual(sorted, { a: { c: 3, d: 2 }, b: 1, list: [3, 1, 2] })
  assert.deepEqual(Object.keys(sorted.a), ['c', 'd'])
  assert.deepEqual(sorted.list, [3, 1, 2])
  assert.notEqual(sorted, input)
  assert.deepEqual(input, { b: 1, a: { d: 2, c: 3 }, list: [3, 1, 2] }, 'input must not be mutated')
  assert.equal(JSON.stringify(input), '{"b":1,"a":{"d":2,"c":3},"list":[3,1,2]}')
})

test('sortKeysDeep: terminates on cyclic input', () => {
  const cyclic = { b: 1, a: 2 }
  cyclic.self = cyclic
  assert.doesNotThrow(() => sortKeysDeep(cyclic), 'sortKeysDeep must not hang or throw on cycles')
})

test('escapeJsonString / unescapeJsonString round-trip', () => {
  const samples = [
    'plain', 'a"b', 'back\\slash', 'line\nbreak', 'tab\tchar',
    '\u0000\u001f', '😀中文', '\ud800', 'quote \' inside',
  ]
  for (const sample of samples) {
    const escaped = escapeJsonString(sample)
    assert.equal(escaped[0], '"', `quotes included for ${JSON.stringify(sample)}`)
    assert.equal(escaped[escaped.length - 1], '"')
    assert.equal(unescapeJsonString(escaped), sample, `round-trip for ${JSON.stringify(sample)}`)
  }
  assert.equal(escapeJsonString('a"b'), '"a\\"b"')
  assert.equal(unescapeJsonString('"a\\"b"'), 'a"b')
  assert.equal(unescapeJsonString('a\\"b'), 'a"b')
})

test('unescapeJsonString: a bad escape returns its input', () => {
  assert.equal(unescapeJsonString('a\\qb'), 'a\\qb')
})

test('summarizeValue: structural statistics match the analysis stats', () => {
  const stats = summarizeValue({ a: [1, { b: 2 }], c: null })
  assert.equal(stats.nodes, 6)
  assert.equal(stats.depth, 4)
  assert.equal(stats.keys, 3)
  assert.equal(stats.arrays, 1)
  assert.equal(stats.objects, 2)
  assert.equal(summarizeValue(42).nodes, 1)
})

test('GAP: summarizeValue returns the full Analysis.stats shape', () => {
  const stats = summarizeValue({ a: 1 })
  const keys = ['bytes', 'chars', 'lines', 'nodes', 'depth', 'keys', 'arrays', 'objects']
  assert.deepEqual(Object.keys(stats).filter((key) => keys.includes(key)).sort(), [...keys].sort(),
    `summarizeValue() must return "same stats shape as Analysis.stats"; got keys ${JSON.stringify(Object.keys(stats))}`)
})
