/**
 * Tolerant JSON analyzer for JSON Studio.
 *
 * The panel must never show a blank box: strict JSON is fast-pathed, JSON-like
 * text is lexed and parsed by a forgiving recursive-descent parser that records
 * every repair, and input that still cannot be parsed is laid out by indentation
 * and bracket depth. Nothing here throws — `analyzeJson` always returns an
 * Analysis object.
 *
 * Plain ESM, no imports, no DOM; also runs under Node tests unchanged.
 */

/** Hard defaults for the analysis bounds. */
const DEFAULT_MAX_BYTES = 4_000_000
const DEFAULT_MAX_NODES = 200_000
const DEFAULT_MAX_DEPTH = 200

/** Canonical JSON number, used to decide whether a number needed a repair. */
const STRICT_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/** Characters treated as insignificant whitespace. */
const WHITESPACE = new Set([' ', '\t', '\r', '\n', '\f', '\v', '\u00a0', '\u3000'])

/** Smart punctuation normalized only after strict parsing failed. */
const SMART_QUOTES = [
  ['\u201c', '"'], ['\u201d', '"'], ['\u2018', "'"], ['\u2019', "'"],
]

/** Invisible characters that routinely ride along when JSON is copied from the web. */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/gu

/**
 * Normalize smart quotes outside any quoted string and drop zero-width
 * characters. String content is never rewritten.
 * @param {string} text - source text.
 * @returns {{ text: string, smart: boolean, zero: boolean }}
 */
function normalizeInvisibles(text) {
  const zero = ZERO_WIDTH.test(text)
  const source = zero ? text.replace(ZERO_WIDTH, '') : text
  const quoteMap = { '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'" }
  const pairs = { '"': '"', "'": "'", '`': '`' }
  let out = ''
  let quote = ''
  let escaped = false
  let smart = false
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]
    if (quote !== '') {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (pairs[ch]) {
      quote = ch
      out += ch
      continue
    }
    if (quoteMap[ch]) {
      out += quoteMap[ch]
      smart = true
      continue
    }
    out += ch
  }
  return { text: out, smart, zero }
}

/** Keywords accepted as literals, with the repair note they imply. */
const LITERALS = {
  true: { value: true },
  false: { value: false },
  null: { value: null },
  True: { value: true, note: 'python-literals' },
  False: { value: false, note: 'python-literals' },
  None: { value: null, note: 'python-literals' },
  nil: { value: null, note: 'python-literals' },
  undefined: { value: null, note: 'python-literals' },
  NaN: { value: NaN, note: 'non-finite' },
  Infinity: { value: Infinity, note: 'non-finite' },
  '-Infinity': { value: -Infinity, note: 'non-finite' },
  '+Infinity': { value: Infinity, note: 'non-finite' },
}

const CLOSER_OF = { '{': '}', '[': ']', '(': ')' }

/** A parser failure carrying the source offset that caused it. */
class LooseError extends Error {
  constructor(message, offset) {
    super(message)
    this.name = 'LooseError'
    this.offset = offset
  }
}

/** @returns whether `ch` is insignificant whitespace. */
function isWhitespace(ch) {
  return WHITESPACE.has(ch)
}

/** @returns the byte length of a string as UTF-8. */
function utf8Bytes(text) {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** @returns the 1-based line and column for a source offset. */
function positionOf(text, offset) {
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

/** @returns whether braces/brackets are unbalanced outside strings. */
function bracketsUnbalanced(text) {
  let depth = 0
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && text[index + 1] === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote !== '') {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && text[index + 1] === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (ch === '/' && text[index + 1] === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth < 0) return true
    }
  }
  return depth !== 0
}

/** @returns a display preview of a value. */
function previewOf(value) {
  try {
    const text = JSON.stringify(value)
    if (typeof text === 'string') return text.length > 60 ? `${text.slice(0, 59)}…` : text
  } catch {
    /* fall through */
  }
  return '…'
}

/** @returns the contract's candidate kind for one recovered value. */
function candidateKind(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'literal'
  const type = typeof value
  if (type === 'object') return 'object'
  if (type === 'string') return 'string'
  if (type === 'number') return 'number'
  return 'literal'
}

/* --------------------------------------------------------------------- lexer */

/**
 * Lex JSON-ish text. Every character is covered by exactly one token, so
 * `tokenizeJson` can rebuild the input from token values.
 * @param {string} text - source text.
 * @returns {Array<object>} tokens: `{ type, value, start, end, raw, terminated? }`.
 */
function lex(text) {
  const tokens = []
  const length = text.length
  let index = 0

  const push = (type, start, end, extra) => {
    const token = { type, start, end, raw: text.slice(start, end), value: text.slice(start, end) }
    if (extra) Object.assign(token, extra)
    tokens.push(token)
  }

  while (index < length) {
    const start = index
    const ch = text[index]

    if (ch === '\n') {
      index += 1
      push('newline', start, index)
      continue
    }
    if (isWhitespace(ch)) {
      index += 1
      while (index < length && isWhitespace(text[index]) && text[index] !== '\n') index += 1
      push('space', start, index)
      continue
    }

    // Comments: // line, /* block */, and # line (only when not a color literal).
    if (ch === '/' && text[index + 1] === '/') {
      index += 2
      while (index < length && text[index] !== '\n') index += 1
      push('comment', start, index)
      continue
    }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2
      while (index < length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index = Math.min(length, index + 2)
      push('comment', start, index)
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      index += 1
      let terminated = false
      while (index < length) {
        const current = text[index]
        if (current === '\\') {
          index += 2
          continue
        }
        if (current === ch) {
          index += 1
          terminated = true
          break
        }
        if (current === '\n' && ch !== '`') {
          break
        }
        index += 1
      }
      push('string', start, Math.min(index, length), { quote: ch, terminated })
      continue
    }

    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === '(' || ch === ')'
      || ch === ':' || ch === ',' || ch === ';' || ch === '=') {
      index += 1
      push('punct', start, index)
      continue
    }

    // Signed non-finite literals.
    if (ch === '-' || ch === '+') {
      const rest = text.slice(index)
      const special = /^[+-]?(?:Infinity|NaN)/.exec(rest)
      if (special) {
        index += special[0].length
        push('ident', start, index)
        continue
      }
    }

    const number = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/.exec(text.slice(index))
    if (number) {
      index += number[0].length
      push('number', start, index)
      continue
    }

    if (/[A-Za-z_$\u00a0-\uffff]/.test(ch)) {
      index += 1
      while (index < length && /[A-Za-z0-9_$\u00a0-\uffff.\-]/.test(text[index])) index += 1
      push('ident', start, index)
      continue
    }

    index += 1
    push('invalid', start, index)
  }
  return tokens
}

/** @returns significant tokens (no whitespace) with a `newline` flag on each. */
function significantTokens(text) {
  const all = lex(text)
  const out = []
  let newline = false
  for (const token of all) {
    if (token.type === 'space' || token.type === 'newline') {
      if (token.type === 'newline' || token.raw.includes('\n')) newline = true
      continue
    }
    if (token.type === 'comment') {
      if (token.raw.includes('\n')) newline = true
      out.push(Object.assign({}, token, { comment: true, newline }))
      newline = token.raw.includes('\n')
      continue
    }
    out.push(Object.assign({}, token, { newline }))
    newline = false
  }
  return out
}

/* -------------------------------------------------------------------- parser */

/** Forgiving recursive-descent parser over significant tokens. */
class LooseParser {
  constructor(text, options = {}) {
    this.text = text
    this.tokens = significantTokens(text)
    this.index = 0
    this.notes = []
    this.noteCodes = new Set()
    this.structural = false
    this.truncated = false
    this.nodes = 0
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
    if (this.tokens.some((token) => token.comment)) this.note('comments')
  }

  note(code, detail) {
    if (this.noteCodes.has(code)) {
      if (detail) {
        const existing = this.notes.find((note) => note.code === code)
        if (existing) existing.detail = detail
      }
      return
    }
    this.noteCodes.add(code)
    this.notes.push(detail ? { code, detail } : { code })
  }

  /** Mark a recovery that invented closing structure. */
  markTruncated() {
    this.truncated = true
    this.structural = true
    this.note('truncated-input')
  }

  /** Mark a wrapper that had to invent an outer array. */
  markMultipleValues() {
    this.structural = true
    this.note('multiple-values')
  }

  get atEnd() {
    while (this.index < this.tokens.length && this.tokens[this.index].comment) this.index += 1
    return this.index >= this.tokens.length
  }

  peek(offset = 0) {
    let cursor = this.index
    let seen = 0
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]
      if (!token.comment) {
        if (seen === offset) return token
        seen += 1
      }
      cursor += 1
    }
    return undefined
  }

  next() {
    while (this.index < this.tokens.length && this.tokens[this.index].comment) {
      this.note('comments')
      this.index += 1
    }
    const token = this.tokens[this.index]
    this.index += 1
    return token
  }

  bump(count = 1) {
    for (let step = 0; step < count; step += 1) this.next()
  }

  fail(message, token) {
    throw new LooseError(message, token ? token.start : this.text.length)
  }

  countNode(depth) {
    this.nodes += 1
    const offset = this.tokens[this.index] ? this.tokens[this.index].start : this.text.length
    if (this.nodes > this.maxNodes) {
      const error = new LooseError('too many nodes', offset)
      error.code = 'too-many-nodes'
      throw error
    }
    if (depth > this.maxDepth) {
      const error = new LooseError('too deep', offset)
      error.code = 'too-deep'
      throw error
    }
  }

  /** @returns every top-level value found in the token stream. */
  parseRoot() {
    const values = []
    while (!this.atEnd) {
      try {
        values.push(this.parseValue(0))
      } catch (error) {
        if (values.length > 0 && error instanceof LooseError) {
          this.note('trailing-garbage')
          break
        }
        throw error
      }
      if (this.atEnd) break
      const token = this.peek()
      if (token.value === ',' || token.value === ';') {
        if (token.value === ';') this.note('semicolon')
        this.next()
        continue
      }
      if (token.value === '}' || token.value === ']' || token.value === ')') {
        this.fail(`unexpected "${token.value}"`, token)
      }
      // NDJSON / concatenated values: keep going only when the next token can
      // start a value; prose after a complete value is trailing garbage.
      const canStart = token.type === 'string' || token.type === 'number'
        || token.value === '{' || token.value === '['
        || (token.type === 'ident' && (token.value in LITERALS))
      if (!canStart) {
        this.note('trailing-garbage')
        break
      }
    }
    if (values.length === 0) {
      this.fail('no JSON value found', this.tokens[0])
    }
    return values
  }

  parseValue(depth) {
    if (this.atEnd) this.fail('unexpected end of input', undefined)
    const token = this.peek()
    if (token.value === '{') return this.parseObject(depth)
    if (token.value === '[' || token.value === '(') return this.parseArray(depth, token.value)
    if (token.type === 'string') {
      this.next()
      if (token.quote !== '"') this.note('single-quotes')
      if (!token.terminated) {
        this.markTruncated()
      }
      this.countNode(depth)
      return decodeString(token.raw, token.quote)
    }
    if (token.type === 'number') {
      this.next()
      this.countNode(depth)
      return parseNumber(token.raw, this, token)
    }
    if (token.type === 'ident') {
      const literal = LITERALS[token.value]
      if (literal) {
        this.next()
        if (literal.note) this.note(literal.note)
        this.countNode(depth)
        return literal.value
      }
      return this.parseBareword(depth)
    }
    this.fail(`unexpected token "${token.raw}"`, token)
  }

  parseKey() {
    const token = this.peek()
    if (!token) this.fail('expected a key', undefined)
    if (token.type === 'string') {
      this.next()
      if (token.quote !== '"') this.note('single-quotes')
      return decodeString(token.raw, token.quote)
    }
    if (token.type === 'ident') {
      this.next()
      this.note('unquoted-key')
      return token.raw
    }
    if (token.type === 'number') {
      this.next()
      this.note('unquoted-key')
      return token.raw
    }
    this.fail('expected a key', token)
  }

  parseBareword(depth) {
    const first = this.next()
    this.note('bareword-value')
    this.structural = true
    const parts = [first.raw]
    let cursor = this.index
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]
      if (token.comment) break
      if (token.newline) break
      if (token.type !== 'ident' && token.type !== 'number' && token.type !== 'invalid') break
      // A bare word followed by `:` is the next key, not part of this value.
      const after = this.peekAt(cursor + 1)
      if (after && (after.value === ':' || after.value === '=')) break
      parts.push(token.raw)
      this.index = cursor + 1
      cursor += 1
    }
    this.countNode(depth)
    return parts.join(' ')
  }

  peekAt(cursor) {
    while (cursor < this.tokens.length && this.tokens[cursor].comment) cursor += 1
    return this.tokens[cursor]
  }

  parseObject(depth) {
    this.next()
    this.countNode(depth)
    const object = {}
    while (true) {
      if (this.atEnd) {
        this.markTruncated()
        return object
      }
      const token = this.peek()
      if (token.value === '}') {
        this.next()
        return object
      }
      const key = this.parseKey()
      if (this.atEnd) {
        this.markTruncated()
        return object
      }
      const separator = this.peek()
      if (separator.value === ':') {
        this.next()
      } else if (separator.value === '=') {
        this.next()
        this.note('equals-colon')
        this.structural = true
      } else {
        this.fail(`expected ":" after key "${key}"`, separator)
      }
      if (this.atEnd) {
        this.markTruncated()
        return object
      }
      const value = this.parseValue(depth + 1)
      if (Object.prototype.hasOwnProperty.call(object, key)) this.note('duplicate-key')
      object[key] = value
      if (this.atEnd) {
        this.markTruncated()
        return object
      }
      const after = this.peek()
      if (after.value === ',') {
        this.next()
        const following = this.peek()
        if (following && following.value === '}') this.note('trailing-comma')
        continue
      }
      if (after.value === ';') {
        this.next()
        this.note('semicolon')
        continue
      }
      if (after.value === '}') {
        this.next()
        return object
      }
      if (after.type === 'string' || after.type === 'ident' || after.type === 'number') {
        this.note('missing-comma')
        this.structural = true
        continue
      }
      this.fail('expected "," or "}"', after)
    }
  }

  parseArray(depth, opener) {
    const closer = CLOSER_OF[opener] || ']'
    this.next()
    this.countNode(depth)
    if (opener === '(') {
      this.note('tuple-array')
      this.structural = true
    }
    const array = []
    while (true) {
      if (this.atEnd) {
        this.markTruncated()
        return array
      }
      const token = this.peek()
      if (token.value === closer) {
        this.next()
        return array
      }
      array.push(this.parseValue(depth + 1))
      if (this.atEnd) {
        this.markTruncated()
        return array
      }
      const after = this.peek()
      if (after.value === ',') {
        this.next()
        const following = this.peek()
        if (following && following.value === closer) this.note('trailing-comma')
        continue
      }
      if (after.value === ';') {
        this.next()
        this.note('semicolon')
        continue
      }
      if (after.value === closer) {
        this.next()
        return array
      }
      if (after.type === 'string' || after.type === 'number' || after.type === 'ident'
        || after.value === '{' || after.value === '[' || after.value === '(') {
        this.note('missing-comma')
        this.structural = true
        continue
      }
      this.fail(`expected "," or "${closer}"`, after)
    }
  }
}

/** @returns the numeric value of a JSON-ish number token. */
function parseNumber(raw, parser, token) {
  if (!STRICT_NUMBER.test(raw)) parser.note('loose-number')
  let normalized = raw.replace(/_/g, '')
  if (normalized.startsWith('+')) normalized = normalized.slice(1)
  if (/^0[xX]/.test(normalized)) return Number.parseInt(normalized.slice(2), 16)
  if (/^[+-]?\.\d/.test(normalized)) {
    normalized = normalized.startsWith('-') ? `-0${normalized.slice(1)}` : `0${normalized}`
  }
  if (/^[+-]?\d+\.$/.test(normalized)) normalized = normalized.slice(0, -1)
  const value = Number(normalized)
  if (Number.isNaN(value)) throw new LooseError(`invalid number "${raw}"`, token ? token.start : 0)
  return value
}

/**
 * Decode one quoted string token, accepting JSON5 and JS escapes.
 * @param raw - token text including quotes.
 * @param quote - the opening quote character.
 */
function decodeString(raw, quote) {
  const body = raw.length >= 2 && raw.endsWith(quote) ? raw.slice(1, -1) : raw.slice(1)
  let out = ''
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index]
    if (ch !== '\\') {
      out += ch
      continue
    }
    index += 1
    const escape = body[index]
    if (escape === undefined) break
    if (escape === 'n') out += '\n'
    else if (escape === 't') out += '\t'
    else if (escape === 'r') out += '\r'
    else if (escape === 'b') out += '\b'
    else if (escape === 'f') out += '\f'
    else if (escape === 'v') out += '\v'
    else if (escape === '0') out += '\0'
    else if (escape === '\n') { /* line continuation */ }
    else if (escape === '\r') {
      if (body[index + 1] === '\n') index += 1
    } else if (escape === 'u') {
      if (body[index + 1] === '{') {
        const close = body.indexOf('}', index)
        if (close > index) {
          const code = Number.parseInt(body.slice(index + 2, close), 16)
          out += Number.isFinite(code) ? String.fromCodePoint(code) : ''
          index = close
        }
      } else {
        const code = Number.parseInt(body.slice(index + 1, index + 5), 16)
        if (Number.isFinite(code)) {
          out += String.fromCharCode(code)
          index += 4
        }
      }
    } else if (escape === 'x') {
      const code = Number.parseInt(body.slice(index + 1, index + 3), 16)
      if (Number.isFinite(code)) {
        out += String.fromCharCode(code)
        index += 2
      }
    } else {
      out += escape
    }
  }
  return out
}

/* ------------------------------------------------------------------ scanning */

/**
 * Find balanced JSON-looking candidates in free text.
 * @param {string} text - source text.
 * @param {object} [options] - `{ limit }`.
 * @returns {Array<{ start:number, end:number, text:string, kind:string }>}
 */
export function findJsonCandidates(text, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 30
  const source = String(text ?? '')
  // Mask fenced-code markers (same length, so offsets stay exact) so the JSON
  // body inside a fence is visible to the scanner instead of one backtick string.
  const scanText = source.replace(/```[^\n]*\n?/gu, (match) => ' '.repeat(match.length))
  const tokens = lex(scanText)
  const candidates = []
  let index = 0
  while (index < tokens.length && candidates.length < limit) {
    const token = tokens[index]
    if (token.type === 'space' || token.type === 'newline' || token.type === 'comment') {
      index += 1
      continue
    }
    if (token.value === '{' || token.value === '[') {
      const start = token.start
      const stack = [token.value]
      let cursor = index + 1
      let end = text.length
      let closed = false
      while (cursor < tokens.length) {
        const current = tokens[cursor]
        if (current.type === 'punct') {
          if (current.value === '{' || current.value === '[') stack.push(current.value)
          else if (current.value === '}' || current.value === ']') {
            const expected = stack[stack.length - 1] === '{' ? '}' : ']'
            if (current.value === expected) stack.pop()
            else break
            if (stack.length === 0) {
              end = current.end
              closed = true
              index = cursor
              break
            }
          }
        }
        cursor += 1
      }
      // A lone opener ("}" then "{") is not a candidate; a truncated but
      // non-trivial group is, so prose-wrapped partial JSON can recover.
      const content = source.slice(start + 1, end)
      if (closed || (end - start > 1 && /[A-Za-z0-9"'`]/u.test(content))) {
        candidates.push({
          start, end, kind: token.value === '{' ? 'object' : 'array',
          text: source.slice(start, end),
        })
      }
      index += 1
      continue
    }
    if (token.type === 'string' || token.type === 'number'
      || (token.type === 'ident' && (token.value in LITERALS))) {
      candidates.push({
        start: token.start, end: token.end,
        kind: token.type === 'string' ? 'string' : token.type === 'number' ? 'number' : 'literal',
        text: source.slice(token.start, token.end),
      })
    }
    index += 1
  }
  return candidates
}

/* --------------------------------------------------------------- formatting */

/** Replace cycles with a marker so stringify never throws. */
function cycleReplacer() {
  const seen = new WeakSet()
  return function replacer(key, value) {
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}

/**
 * Pretty-print a value as JSON.
 * @param value - any value.
 * @param indent - indentation width.
 */
export function formatValue(value, indent = 2) {
  try {
    const text = JSON.stringify(value, cycleReplacer(), indent)
    if (typeof text === 'string') return text
  } catch {
    /* fall through */
  }
  return String(value)
}

/** @returns compact JSON for a value. */
export function minifyValue(value) {
  try {
    const text = JSON.stringify(value, cycleReplacer())
    if (typeof text === 'string') return text
  } catch {
    /* fall through */
  }
  return String(value)
}

/** @returns a new value with object keys sorted recursively. */
export function sortKeysDeep(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item, seen))
  const sorted = {}
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = sortKeysDeep(value[key], seen)
  }
  return sorted
}

/**
 * Escape text into a JSON string literal (quotes included).
 * @param text - raw text.
 */
export function escapeJsonString(text) {
  return JSON.stringify(String(text ?? ''))
}

/**
 * Undo one level of JSON string escaping. A bare escaped body is accepted too.
 * @param text - literal or escaped body.
 */
export function unescapeJsonString(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return raw
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed
    } catch {
      /* fall through */
    }
  }
  try {
    const parsed = JSON.parse(`"${raw.replace(/(^|[^\\])"/g, '$1\\"')}"`)
    if (typeof parsed === 'string') return parsed
  } catch {
    /* fall through */
  }
  return raw
}

/** @returns structural statistics for a value. */
export function summarizeValue(value) {
  const stats = { bytes: 0, chars: 0, lines: 0, nodes: 0, depth: 0, keys: 0, arrays: 0, objects: 0 }
  try {
    const text = JSON.stringify(value) ?? ''
    stats.bytes = utf8Bytes(text)
    stats.chars = text.length
    stats.lines = text === '' ? 0 : text.split('\n').length
  } catch {
    /* a hostile value still gets structural counts */
  }
  if (value === undefined) return stats
  const seen = new WeakSet()
  const stack = [{ value, depth: 1 }]
  let guard = 0
  while (stack.length > 0 && guard < 1_000_000) {
    guard += 1
    const { value: current, depth } = stack.pop()
    stats.nodes += 1
    if (depth > stats.depth) stats.depth = depth
    if (current === null || typeof current !== 'object') continue
    if (seen.has(current)) continue
    seen.add(current)
    if (Array.isArray(current)) {
      stats.arrays += 1
      for (const item of current) stack.push({ value: item, depth: depth + 1 })
    } else {
      stats.objects += 1
      const keys = Object.keys(current)
      stats.keys += keys.length
      for (const key of keys) stack.push({ value: current[key], depth: depth + 1 })
    }
  }
  return stats
}

/**
 * Tokenize JSON-ish text for syntax highlighting.
 * `tokens.map(t => t.value).join('')` always equals the input.
 * @param {string} text - source text.
 * @returns {Array<{ type:string, value:string, start:number, end:number }>}
 */
export function tokenizeJson(text) {
  const source = String(text ?? '')
  const tokens = lex(source)
  const out = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    let type = token.type
    if (type === 'newline' || type === 'space' || type === 'comment') {
      out.push({ type, value: token.raw, start: token.start, end: token.end })
      continue
    }
    if (type === 'punct') {
      out.push({ type, value: token.raw, start: token.start, end: token.end })
      continue
    }
    if (type === 'string') {
      let cursor = index + 1
      while (cursor < tokens.length && (tokens[cursor].type === 'space' || tokens[cursor].type === 'newline')) cursor += 1
      const isKey = tokens[cursor] && tokens[cursor].type === 'punct' && tokens[cursor].value === ':'
      out.push({
        type: isKey ? 'key' : 'string', value: token.raw, start: token.start, end: token.end,
      })
      continue
    }
    if (type === 'number') {
      out.push({ type: 'number', value: token.raw, start: token.start, end: token.end })
      continue
    }
    if (type === 'ident') {
      const literal = token.raw in LITERALS
      out.push({
        type: literal ? 'literal' : 'bare', value: token.raw, start: token.start, end: token.end,
      })
      continue
    }
    out.push({
      type: token.type === 'invalid' ? 'invalid' : 'bare',
      value: token.raw, start: token.start, end: token.end,
    })
  }
  return out
}

/* ------------------------------------------------------------- loose layout */

/**
 * Lay out arbitrary JSON-ish text with indentation, tolerating broken syntax.
 * Never throws; whitespace is normalized.
 * @param {string} text - source text.
 * @returns {string} tidied text.
 */
export function prettyLoose(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return ''
  const tokens = lex(source).filter((token) => token.type !== 'space' && token.type !== 'newline')
  let out = ''
  let indent = 0
  let atLineStart = true
  let previous = null

  const pad = () => '  '.repeat(Math.max(0, indent))
  const write = (chunk) => {
    if (atLineStart && chunk !== '\n') {
      out += pad()
      atLineStart = false
    }
    out += chunk
  }
  const newline = () => {
    if (out.length === 0) return
    if (!out.endsWith('\n')) out += '\n'
    atLineStart = true
  }
  const isValueToken = (token) => token && (token.type === 'string' || token.type === 'number'
    || token.type === 'ident' || token.type === 'invalid'
    || token.value === '{' || token.value === '[' || token.value === '(')

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'comment') {
      write(token.raw)
      newline()
      previous = token
      continue
    }
    if (token.value === '}' || token.value === ']' || token.value === ')') {
      indent = Math.max(0, indent - 1)
      newline()
      write(token.raw)
      previous = token
      continue
    }
    if (token.value === '{' || token.value === '[' || token.value === '(') {
      const next = tokens[index + 1]
      const close = CLOSER_OF[token.value]
      if (previous && (previous.type === 'ident' || previous.type === 'invalid')) write(' ')
      if (next && next.value === close) {
        write(token.raw + close)
        index += 1
        previous = next
        continue
      }
      write(token.raw)
      newline()
      indent += 1
      previous = token
      continue
    }
    if (token.value === ',') {
      write(',')
      newline()
      previous = token
      continue
    }
    if (token.value === ':') {
      write(': ')
      previous = token
      continue
    }
    if (token.value === ';') {
      write(';')
      newline()
      previous = token
      continue
    }
    if (isValueToken(token) && previous && isValueToken(previous)) {
      const barePair = (previous.type === 'ident' || previous.type === 'invalid')
        && (token.type === 'ident' || token.type === 'invalid')
      if (barePair) write(' ')
      else newline()
    } else if (isValueToken(token) && previous && (previous.value === '}' || previous.value === ']' || previous.value === ')')) {
      newline()
    }
    write(token.raw)
    previous = token
  }
  return out.replace(/\n+$/u, '')
}

/* -------------------------------------------------------------------- analyze */

/**
 * Analyze JSON-ish text.
 * @param {string} text - input.
 * @param {{ maxBytes?:number, maxNodes?:number, maxDepth?:number }} [options]
 * @returns {object} Analysis per CONTRACT.md.
 */

/* ------------------------------------------- nested / percent JSON repair ---- */

/** Find the matching close position of a `{` / `[` starting at `start`. */
function scanBalanced(text, start) {
  const open = text[start]
  if (open !== '{' && open !== '[') return -1
  const stack = [open]
  let inString = false
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') { i += 1; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      stack.pop()
      if (stack.length === 0) return i + 1
    }
  }
  return -1
}

/** Apply replacements right-to-left so original offsets stay valid. */
function applyReplacements(text, replacements) {
  let out = text
  for (const item of replacements.slice().sort((a, b) => b.start - a.start)) {
    if (item.start < 0 || item.end > out.length || item.start > item.end) continue
    out = out.slice(0, item.start) + item.text + out.slice(item.end)
  }
  return out
}

/**
 * Repair real-world log text: JSON embedded in a string WITHOUT escaping
 * (`"data":"{"a":1}"`), percent-encoded JSON (`"data":"%7B%22a%22..."`) and
 * duplicate segments separated by `;`. Returns the rewritten text plus flags.
 */
function repairNestedAndPercent(text) {
  const replacements = []
  let nested = false
  let percent = false

  // 1) "key":"{...}" / "key":"[...]" — raw JSON hidden in a string.
  const nestedRe = /"([^"\\]+)"\s*:\s*"\s*([{[}])/g
  let match
  while ((match = nestedRe.exec(text)) !== null) {
    const bracePos = match.index + match[0].length - 1
    const innerEnd = scanBalanced(text, bracePos)
    if (innerEnd < 0) continue
    const inner = text.slice(bracePos, innerEnd)
    try { JSON.parse(inner) } catch { continue }
    let close = innerEnd
    while (close < text.length && /\s/u.test(text[close])) close += 1
    if (text[close] !== '"') continue
    replacements.push({ start: match.index, end: close + 1, text: `"${match[1]}":${inner}` })
    nested = true
    nestedRe.lastIndex = close + 1
  }

  // 2) "key":"%7B..." — percent-encoded JSON.
  const percentRe = /"([A-Za-z_][\w]*)"\s*:\s*"(%-?[0-9A-Fa-f]{2}[^"]*)"/g
  while ((match = percentRe.exec(text)) !== null) {
    let decoded
    try { decoded = decodeURIComponent(match[2].replace(/\+/gu, ' ')) } catch { continue }
    const value = decoded.trim()
    if (!/^[[{]/u.test(value)) continue
    try { JSON.parse(value) } catch { continue }
    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      text: `"${match[1]}":${value}`,
    })
    percent = true
  }

  return {
    text: applyReplacements(text, replacements),
    changed: replacements.length > 0,
    nested,
    percent,
  }
}

/** Collect every top-level balanced object/array from the text. */
function collectSegments(text) {
  const segments = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{' || text[i] === '[') {
      const end = scanBalanced(text, i)
      if (end > 0) {
        segments.push(text.slice(i, end))
        i = end - 1
      }
    }
  }
  return segments
}

/** Build a successful Analysis from repaired segments. */
function finishRepair(values, notes, baseStats, maxNodes, maxDepth, truncated, started) {
  let value = values.length === 1 ? values[0] : values
  const stats = summarizeValue(value)
  if (stats.depth > maxDepth) noteNote(notes, 'too-deep')
  if (stats.nodes > maxNodes) noteNote(notes, 'too-many-nodes')
  const basics = baseStats()
  return {
    ok: true,
    mode: 'relaxed',
    value,
    formatted: formatValue(value),
    notes,
    error: null,
    stats: { ...stats, bytes: basics.bytes, chars: basics.chars, lines: basics.lines },
    candidates: [],
    truncated,
    ms: Math.max(0, Date.now() - started),
  }
}

/** Append a note code if not already present. */
function noteNote(notes, code, detail) {
  if (notes.some((item) => item.code === code)) return
  notes.push(detail ? { code, detail } : { code })
}

export function analyzeJson(text, options = {}) {
  const started = Date.now()
  const raw = String(text ?? '')
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES
  const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : DEFAULT_MAX_NODES
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH
  const bytes = utf8Bytes(raw)
  let source = raw
  let truncated = false
  const notes = []
  const noteCodes = new Set()
  const note = (code, detail) => {
    if (noteCodes.has(code)) {
      if (detail) {
        const existing = notes.find((item) => item.code === code)
        if (existing) existing.detail = detail
      }
      return
    }
    noteCodes.add(code)
    notes.push(detail ? { code, detail } : { code })
  }

  if (source.charCodeAt(0) === 0xfeff) {
    source = source.slice(1)
    note('bom')
  }
  if (bytes > maxBytes) {
    source = source.slice(0, maxBytes)
    truncated = true
    note('input-too-large')
  }
  const trimmed = source.trim()
  const baseStats = () => ({
    bytes, chars: raw.length, lines: raw === '' ? 0 : raw.split('\n').length,
    nodes: 0, depth: 0, keys: 0, arrays: 0, objects: 0,
  })

  if (trimmed === '') {
    return {
      ok: false, mode: 'fallback', value: undefined, formatted: '',
      notes: [{ code: 'empty-input' }], error: null, stats: baseStats(),
      candidates: [], truncated: false, ms: Math.max(0, Date.now() - started),
    }
  }

  const finish = (result) => ({
    ...result,
    ms: Math.max(0, Date.now() - started),
  })

  /* 1b. Repair unescaped / percent-encoded JSON embedded in strings and logs
   * BEFORE the strict pass, so a valid outer JSON whose values were decoded
   * still reports the repair and is not mistaken for a clean strict result. */
  const repaired = repairNestedAndPercent(trimmed)
  const wasRepaired = repaired.changed
  if (repaired.nested) note('nested-json-decoded')
  if (repaired.percent) note('percent-decoded')
  const prepared = repaired.text

  /** Parse one cleaned source with the loose parser. */
  const looseParse = (input) => {
    const parser = new LooseParser(input, { maxNodes, maxDepth })
    const values = parser.parseRoot()
    let value = values.length === 1 ? values[0] : values
    if (values.length > 1) parser.markMultipleValues()
    return { parser, value, values }
  }

  /* 1. Strict JSON, plus one level of escaped-JSON-string decoding. */
  try {
    let value = JSON.parse(prepared)
    let escaped = false
    if (typeof value === 'string' && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      const inner = value.trim()
      const looksStructured = inner !== '' && (/^[\[{"\d-]/u.test(inner) || /^(?:true|false|null)\b/u.test(inner))
      if (looksStructured) {
        try {
          value = JSON.parse(inner)
          escaped = true
          note('escaped-string')
        } catch {
          /* keep the string itself */
        }
      }
    }
    const valueStats = summarizeValue(value)
    if (valueStats.depth > maxDepth) note('too-deep')
    if (valueStats.nodes > maxNodes) note('too-many-nodes')
    const basics = baseStats()
    return finish({
      ok: true, mode: (escaped || wasRepaired) ? 'relaxed' : 'strict', value, formatted: formatValue(value),
      notes: notes.slice(), error: null,
      stats: { ...valueStats, bytes: basics.bytes, chars: basics.chars, lines: basics.lines },
      candidates: [{ start: source.indexOf(trimmed), end: source.indexOf(trimmed) + trimmed.length, kind: candidateKind(value), preview: previewOf(value) }],
      truncated,
    })
  } catch {
    /* keep going */
  }

  /* 1c. If repair happened but the whole text is still not one JSON value,
   * try each balanced top-level segment (multiple log entries / segments). */
  if (wasRepaired) {
    const segments = collectSegments(prepared)
    const values = []
    for (const segment of segments) {
      try { values.push(JSON.parse(segment)) } catch { /* skip */ }
    }
    if (values.length > 0) {
      if (values.length > 1) note('multiple-values')
      return finishRepair(values, notes.slice(), baseStats, maxNodes, maxDepth, truncated, started)
    }
    source = prepared
  }

  /* 2. Normalize the obvious noise. */
  let cleaned = source
  const invisibles = normalizeInvisibles(cleaned)
  if (invisibles.zero) note('zero-width')
  if (invisibles.smart) note('smart-quotes')
  cleaned = invisibles.text
  // Fenced code block: use the block's content, closed or not.
  const fenced = /```[^\n]*\n?([\s\S]*?)```/u.exec(cleaned)
  if (fenced && fenced[1].trim() !== '') {
    if (fenced[1].trim() !== cleaned.trim()) note('strip-fence')
    cleaned = fenced[1]
  } else if (/^\s*```/u.test(cleaned)) {
    note('strip-fence')
    cleaned = cleaned.replace(/^\s*```[^\n]*\n?/u, '').replace(/\n?```\s*$/u, '')
  }
  // HTTP response headers before the body (with or without a blank line).
  if (/^\s*HTTP\/\d(?:\.\d)?\s+\d{3}/u.test(cleaned)) {
    const split = cleaned.search(/\r?\n\r?\n/u)
    if (split >= 0) {
      note('header-footer')
      cleaned = cleaned.slice(split).replace(/^\r?\n\r?\n/u, '')
    } else {
      const lines = cleaned.split(/\r?\n/u)
      const start = lines.findIndex((line, index) => index > 0 && /^\s*[[{]/u.test(line))
      if (start > 0) {
        note('header-footer')
        cleaned = lines.slice(start).join('\n')
      }
    }
  }
  // JSONP wrapper: callback({...});
  const jsonp = /^\s*[A-Za-z_$][\w$.]*\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/u.exec(cleaned)
  if (jsonp && jsonp[1].trim() !== '') {
    note('jsonp-wrapper')
    cleaned = jsonp[1]
  }

  /* 3. Loose parse. */
  let parsed = null
  let parseError = null
  try {
    parsed = looseParse(cleaned)
  } catch (error) {
    parseError = error
    if (error instanceof LooseError) {
      /* fall through to candidates */
    } else {
      throw error
    }
  }

  /* 4. Candidate extraction for prose-wrapped or partially broken text. */
  const structuredCandidates = findJsonCandidates(cleaned)
    .filter((candidate) => candidate.kind === 'object' || candidate.kind === 'array')
  if (parsed !== null && parsed.parser.noteCodes.has('bareword-value') && structuredCandidates.length > 0) {
    // A prose prefix parsed as a bare word while a real JSON body follows it.
    parsed = null
  }
  if (parsed === null) {
    const candidates = structuredCandidates
    const successes = []
    for (const candidate of candidates) {
      try {
        const candidateParsed = looseParse(candidate.text)
        successes.push({ candidate, parsed: candidateParsed })
      } catch {
        /* try the next candidate */
      }
    }
    if (successes.length > 0) {
      const chosen = successes[0]
      for (const item of chosen.parsed.parser.notes) {
        if (item.code === 'trailing-garbage' || item.code === 'missing-comma') continue
        note(item.code, item.detail)
      }
      if (cleaned.trim() !== chosen.candidate.text.trim()) note('strip-prose')
      if (successes.length > 1) note('multiple-values')
      parsed = {
        parser: chosen.parsed.parser,
        value: successes.length > 1 ? successes.map((item) => item.parsed.value) : chosen.parsed.value,
      }
    }
  }

  /* 5. Nothing parsed: fallback layout with the error position. */
  if (parsed === null) {
    const warning = parseError ? parseError.message : 'cannot parse input'
    const offset = parseError && Number.isFinite(parseError.offset) ? parseError.offset : 0
    const position = positionOf(source, offset)
    const fallbackNotes = notes.slice()
    const pushNote = (code) => {
      if (!fallbackNotes.some((item) => item.code === code)) fallbackNotes.push({ code })
    }
    if (/end of input/i.test(warning)) pushNote('truncated-input')
    if (bracketsUnbalanced(source)) pushNote('unbalanced-brackets')
    if (parseError && (parseError.code === 'too-deep' || parseError.code === 'too-many-nodes')) {
      pushNote(parseError.code)
    }
    if (fallbackNotes.length === notes.length) pushNote('unexpected-token')
    return finish({
      ok: false, mode: 'fallback', value: undefined, formatted: prettyLoose(source),
      notes: fallbackNotes,
      error: {
        message: warning, offset, line: position.line, column: position.column,
      },
      stats: baseStats(), candidates: findJsonCandidates(source, { limit: 10 }).map((candidate) => ({
        start: candidate.start, end: candidate.end, kind: candidate.kind,
        preview: candidate.text.slice(0, 60),
      })),
      truncated: truncated || /end of input/i.test(warning),
    })
  }

  /* 6. Merge parser notes and decide the mode. */
  const parser = parsed.parser
  for (const item of parser.notes) note(item.code, item.detail)
  let value = parsed.value

  // An escaped JSON string: one more level of decoding when it was a string.
  if (typeof value === 'string' && trimmed.startsWith('"')) {
    const inner = value.trim()
    if (/^[\[{"\d-]/u.test(inner) || /^(?:true|false|null)\b/u.test(inner)) {
      try {
        const innerParsed = looseParse(inner)
        value = innerParsed.value
        for (const item of innerParsed.parser.notes) note(item.code, item.detail)
        note('escaped-string')
      } catch {
        /* keep the string */
      }
    }
  }

  const mode = parser.structural ? 'repaired' : 'relaxed'
  const valueStats = summarizeValue(value)
  if (valueStats.depth > maxDepth) note('too-deep')
  if (valueStats.nodes > maxNodes) note('too-many-nodes')
  const basics = baseStats()
  return finish({
    ok: true,
    mode,
    value,
    formatted: formatValue(value),
    notes: notes.slice(),
    error: null,
    stats: { ...valueStats, bytes: basics.bytes, chars: basics.chars, lines: basics.lines },
    candidates: findJsonCandidates(source, { limit: 10 }).map((candidate) => ({
      start: candidate.start, end: candidate.end, kind: candidate.kind,
      preview: candidate.text.length > 80 ? `${candidate.text.slice(0, 79)}…` : candidate.text,
    })),
    truncated: truncated || parser.truncated,
  })
}
