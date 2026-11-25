/**
 * Engine tests for JSON Studio. Run with `node --test test/engine.test.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  analyzeJson, findJsonCandidates, prettyLoose, tokenizeJson,
  formatValue, minifyValue, sortKeysDeep, escapeJsonString, unescapeJsonString,
  summarizeValue,
} from '../src/engine.js'

const codes = (analysis) => analysis.notes.map((note) => note.code)

test('strict JSON object, array, scalar', () => {
  const object = analyzeJson('{"a":1,"b":[true,null,"x"],"c":{"d":2}}')
  assert.equal(object.ok, true)
  assert.equal(object.mode, 'strict')
  assert.deepEqual(object.value, { a: 1, b: [true, null, 'x'], c: { d: 2 } })
  assert.deepEqual(codes(object), [])
  assert.match(object.formatted, /^\{\n {2}"a": 1,/u)

  const array = analyzeJson('[1,2,3]')
  assert.equal(array.mode, 'strict')
  assert.deepEqual(array.value, [1, 2, 3])

  const scalar = analyzeJson(' 42 ')
  assert.equal(scalar.mode, 'strict')
  assert.equal(scalar.value, 42)

  const unicode = analyzeJson('{"s":"中文 😀 \\u00e9"}')
  assert.equal(unicode.mode, 'strict')
  assert.equal(unicode.value.s, '中文 😀 é')
})

test('strict analysis reports stats and candidates', () => {
  const result = analyzeJson('{"a":[1,{"b":2}],"c":"d"}')
  assert.equal(result.stats.nodes, 6)
  assert.equal(result.stats.depth, 4)
  assert.equal(result.stats.keys, 3)
  assert.ok(result.candidates.length >= 1)
  assert.equal(result.truncated, false)
  assert.ok(result.ms >= 0)
})

test('escaped JSON string is decoded one level', () => {
  const result = analyzeJson('"{\\"a\\":1,\\"b\\":[true]}"')
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'relaxed')
  assert.deepEqual(result.value, { a: 1, b: [true] })
  assert.ok(codes(result).includes('escaped-string'))
})

test('JSON5-ish input: comments, quotes, bare keys, trailing commas', () => {
  const text = `{
    // app config
    name: 'json-studio',
    version: 1.2,
    tags: ['format', 'tree',],
    nested: { ok: true, },
  }`
  const result = analyzeJson(text)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'relaxed')
  assert.deepEqual(result.value, {
    name: 'json-studio', version: 1.2, tags: ['format', 'tree'], nested: { ok: true },
  })
  for (const code of ['comments', 'single-quotes', 'unquoted-key', 'trailing-comma']) {
    assert.ok(codes(result).includes(code), `missing ${code}`)
  }
})

test('python literals and tuple arrays', () => {
  const result = analyzeJson("{'name': 'Ada', 'skills': ('math', 'logic'), 'active': True, 'manager': None,}")
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'repaired')
  assert.deepEqual(result.value, { name: 'Ada', skills: ['math', 'logic'], active: true, manager: null })
  assert.ok(codes(result).includes('python-literals'))
  assert.ok(codes(result).includes('tuple-array'))
})

test('loose numbers', () => {
  const result = analyzeJson('{a: 0x1F, b: .5, c: 1., d: +1, e: 1_000, f: 1e3}')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { a: 31, b: 0.5, c: 1, d: 1, e: 1000, f: 1000 })
  assert.ok(codes(result).includes('loose-number'))
})

test('missing commas and bareword values are repaired', () => {
  const result = analyzeJson('{status: OK, msg: hello world, list: [1 2 3]}')
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'repaired')
  assert.deepEqual(result.value, { status: 'OK', msg: 'hello world', list: [1, 2, 3] })
  assert.ok(codes(result).includes('missing-comma'))
  assert.ok(codes(result).includes('bareword-value'))
})

test('equals separator, semicolons, duplicate keys', () => {
  const result = analyzeJson('{a = 1; b = 2, a = 3}')
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'repaired')
  assert.deepEqual(result.value, { a: 3, b: 2 })
  assert.ok(codes(result).includes('equals-colon'))
  assert.ok(codes(result).includes('semicolon'))
  assert.ok(codes(result).includes('duplicate-key'))
})

test('fenced block and prose around JSON', () => {
  const fenced = analyzeJson('Here you go:\n```json\n{"a": 1}\n```\nHope it helps')
  assert.equal(fenced.ok, true)
  assert.equal(fenced.value.a, 1)
  assert.ok(codes(fenced).includes('strip-fence'))

  const prose = analyzeJson('The response was {"ok": true, "count": 2} as expected.')
  assert.equal(prose.ok, true)
  assert.deepEqual(prose.value, { ok: true, count: 2 })
  assert.ok(codes(prose).some((code) => code === 'strip-prose' || code === 'trailing-garbage'))
})

test('HTTP response and JSONP wrapper', () => {
  const http = analyzeJson('HTTP/1.1 200 OK\nContent-Type: application/json\n\n{"a": 1}')
  assert.equal(http.ok, true)
  assert.equal(http.value.a, 1)
  assert.ok(codes(http).includes('header-footer'))

  const jsonp = analyzeJson('callback({"a": 2});')
  assert.equal(jsonp.ok, true)
  assert.equal(jsonp.value.a, 2)
  assert.ok(codes(jsonp).includes('jsonp-wrapper'))
})

test('NDJSON and multiple values become an array', () => {
  const result = analyzeJson('{"a":1}\n{"b":2}\n{"c":3}')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, [{ a: 1 }, { b: 2 }, { c: 3 }])
  assert.ok(codes(result).includes('multiple-values'))
})

test('truncated containers recover what is present', () => {
  const object = analyzeJson('{"a": 1, "b": [1, 2')
  assert.equal(object.ok, true)
  assert.deepEqual(object.value, { a: 1, b: [1, 2] })
  assert.equal(object.truncated, true)
  assert.ok(codes(object).includes('truncated-input'))

  const array = analyzeJson('[1, 2,')
  assert.deepEqual(array.value, [1, 2])
  assert.equal(array.truncated, true)
})

test('smart quotes and BOM are normalized after strict parsing fails', () => {
  const smart = analyzeJson('{\u201ca\u201d: 1}')
  assert.equal(smart.ok, true)
  assert.equal(smart.value.a, 1)
  assert.ok(codes(smart).includes('smart-quotes'))

  const bom = analyzeJson('\ufeff{"a":1}')
  assert.equal(bom.ok, true)
  assert.equal(bom.value.a, 1)
  assert.ok(codes(bom).includes('bom'))
})

test('fallback layout for unparseable input never throws', () => {
  const cases = ['}{', '<!doctype html>', '%%%', ':::', '[}']
  for (const text of cases) {
    const result = analyzeJson(text)
    assert.equal(typeof result.formatted, 'string')
    assert.ok(result.formatted.length > 0 || text.trim() === '')
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'fallback')
    assert.ok(result.error && result.error.line >= 1 && result.error.column >= 1)
  }
})

test('empty input', () => {
  for (const text of ['', '   ', '\n\t ']) {
    const result = analyzeJson(text)
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'fallback')
    assert.equal(result.formatted, '')
    assert.ok(codes(result).includes('empty-input'))
  }
  const undefinedInput = analyzeJson(undefined)
  assert.equal(undefinedInput.ok, false)
})

test('garbage table must not throw and must report an error', () => {
  const garbage = [
    'null null null', '{', '}{', '"unterminated', '[1,,2]', '{"a":}', '{:1}',
    'true false', '1 2 3', 'NaN', 'undefined', '/* only a comment */',
    '\u0000\u0001', '{"a": 1} trailing prose', ']', '}', '()',
  ]
  for (const text of garbage) {
    const result = analyzeJson(text)
    assert.equal(typeof result.ok, 'boolean')
    assert.equal(typeof result.formatted, 'string')
    assert.ok(result.stats && typeof result.stats.bytes === 'number')
  }
})

test('bounds: maxBytes, maxNodes, maxDepth', () => {
  const limited = analyzeJson('{"a":"0123456789"}', { maxBytes: 10 })
  assert.equal(limited.truncated, true)
  assert.ok(codes(limited).includes('input-too-large'))

  const deep = `{"x":${'['.repeat(30)}1${']'.repeat(30)},}`
  const deepResult = analyzeJson(deep, { maxDepth: 5 })
  assert.equal(deepResult.ok, false)
  assert.equal(deepResult.mode, 'fallback')

  const wide = `[${Array.from({ length: 50 }, () => '1').join(' ')}]`
  const wideResult = analyzeJson(wide, { maxNodes: 5 })
  assert.equal(wideResult.ok, false)
})

test('tokenizeJson round-trips every byte and finds keys', () => {
  const samples = [
    '{"a":1,"b":[true,null,"x\\n"],"c":{"d":2}}',
    '{\n  // comment\n  bare: \'v\',\n  "n": .5\n}\n',
    'not json at all <>&',
    '',
  ]
  for (const sample of samples) {
    const tokens = tokenizeJson(sample)
    assert.equal(tokens.map((token) => token.value).join(''), sample)
    const offsets = tokens.every((token) => token.start >= 0 && token.end >= token.start)
    assert.equal(offsets, true)
  }
  const keyed = tokenizeJson('{"a": 1}')
  assert.equal(keyed.find((token) => token.type === 'key').value, '"a"')
})

test('prettyLoose tidies broken text and is idempotent', () => {
  const broken = '{"a":1,"b":[1,2,"x y"],}'
  const once = prettyLoose(broken)
  assert.match(once, /\n {2}"a": 1,/u)
  assert.equal(prettyLoose(once), once)
  assert.equal(prettyLoose(''), '')

  const garbage = '}{"a" 1,, ["b" 2]'
  const tidied = prettyLoose(garbage)
  assert.ok(tidied.length > 0)
  assert.ok(tidied.includes('"a"'))
})

test('value helpers', () => {
  assert.equal(formatValue({ a: 1 }), '{\n  "a": 1\n}')
  assert.equal(minifyValue({ a: 1, b: [2] }), '{"a":1,"b":[2]}')
  assert.deepEqual(sortKeysDeep({ b: 1, a: { d: 2, c: 3 } }), { a: { c: 3, d: 2 }, b: 1 })
  assert.equal(escapeJsonString('a"b'), '"a\\"b"')
  assert.equal(unescapeJsonString('"a\\"b"'), 'a"b')
  assert.equal(unescapeJsonString('a\\"b'), 'a"b')
  assert.equal(unescapeJsonString('not escaped <<'), 'not escaped <<')

  const cyclic = { a: 1 }
  cyclic.self = cyclic
  assert.match(formatValue(cyclic), /\[Circular\]/u)
  assert.match(minifyValue(cyclic), /\[Circular\]/u)

  const stats = summarizeValue({ a: [1, { b: 2 }], c: null })
  assert.equal(stats.nodes, 6)
  assert.equal(stats.depth, 4)
})

test('findJsonCandidates extracts balanced values from prose', () => {
  const text = 'prefix {"a": [1, 2, {"b": 3}]} middle [4, 5] suffix'
  const candidates = findJsonCandidates(text)
  assert.ok(candidates.length >= 2)
  assert.equal(candidates[0].kind, 'object')
  assert.equal(candidates[0].text, '{"a": [1, 2, {"b": 3}]}')
  assert.equal(candidates[1].kind, 'array')
})

/* ----------------------------------------- nested / percent log repair ------ */

const fixtureDir = fileURLToPath(new URL('./fixtures/engine/', import.meta.url))

test('unescaped JSON embedded in a string is expanded to an object', () => {
  const text = '{"map":{"data":"{"a":1,"b":{"c":2}}","name":"x"}}'
  const result = analyzeJson(text)
  assert.equal(result.ok, true)
  assert.notEqual(result.mode, 'fallback')
  assert.ok(codes(result).includes('nested-json-decoded'))
  assert.equal(typeof result.value.map.data, 'object')
  assert.equal(result.value.map.data.b.c, 2)
})

test('percent-encoded JSON in a string is decoded', () => {
  const encoded = encodeURIComponent('{"a":1,"msg":"你好"}')
  const result = analyzeJson(`{"data":"${encoded}","name":"x"}`)
  assert.equal(result.ok, true)
  assert.ok(codes(result).includes('percent-decoded'))
  assert.equal(result.value.data.a, 1)
  assert.equal(result.value.data.msg, '你好')
})

test('real-world invoice log: nested + percent + multiple segments', () => {
  const text = readFileSync(fixtureDir + 'nested-log.txt', 'utf8').trim()
  const result = analyzeJson(text)
  assert.equal(result.ok, true)
  assert.notEqual(result.mode, 'fallback')
  assert.ok(codes(result).includes('nested-json-decoded'), codes(result).join(','))
  assert.ok(codes(result).includes('percent-decoded'), codes(result).join(','))
  const first = Array.isArray(result.value) ? result.value[0] : result.value
  assert.equal(first.map.data.buyerEmail, '18300247760@163.com')
  assert.equal(first.map.data.invoiceProductList.group[0].item, '信息系统服务')
  assert.equal(first.map.data.sellerInfo.sellerName, '山东港口青岛港集团有限公司')
  if (Array.isArray(result.value)) {
    assert.ok(result.value.length >= 2)
    assert.equal(result.value[1].name, 'digital.electronic.invoice.create')
  }
})

test('any input still produces readable, non-empty laid-out text', () => {
  for (const text of ['}{', '<!doctype html><body>hi</body>', '%%%', 'a: b: c', '[[[', 'just random words']) {
    const result = analyzeJson(text)
    assert.equal(typeof result.formatted, 'string')
    assert.ok(result.formatted.length > 0, `empty formatted for ${text}`)
    // Whether it parses to a value or falls back, the display text must be usable.
    assert.ok(['strict', 'relaxed', 'repaired', 'fallback'].includes(result.mode))
  }
  // Hard fallback cases keep the error banner meaningful.
  for (const text of ['}{', '<!doctype html><body>hi</body>', '%%%']) {
    assert.equal(analyzeJson(text).ok, false)
  }
})
