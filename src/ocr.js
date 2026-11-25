/**
 * Host-side OCR engine for JSON Studio.
 *
 * The Harness Host process cannot read this plugin's `node_modules` (its
 * filesystem view is separate from the tools that installed them), so OCR runs
 * in a child process started with the system `node` binary. That child resolves
 * `tesseract.js` from the plugin directory and answers over JSON lines; this
 * module owns validation, serialization, timeouts and lifecycle.
 *
 * Public surface: `createOcrEngine({ langDir, defaultLangs })` →
 * `{ recognize, describe, dispose }`.
 */
import { existsSync, readdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createInterface } from 'node:readline'

const ENGINE = 'tesseract.js'

/** Absolute path of the worker script. */
const WORKER_PATH = fileURLToPath(new URL('./ocr-worker.mjs', import.meta.url))

/** Package root, used as the worker's cwd. */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000

const LANG_CODE_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const TRAINEDDATA_RE = /^(.*)\.traineddata(\.gz)?$/

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

const MIME_BY_TYPE = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const MIME_ALIASES = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Error with a stable `code` the route layer can map to an HTTP status. */
function ocrError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/** Accept a function or a minimal logger object; never let logging throw. */
function makeLogSink(logger) {
  let sink = () => {}
  if (typeof logger === 'function') sink = logger
  else if (logger && typeof logger.info === 'function') sink = (message) => logger.info(message)
  else if (logger && typeof logger.debug === 'function') sink = (message) => logger.debug(message)
  return (message) => {
    try {
      sink(message)
    } catch {
      /* logging must never break OCR */
    }
  }
}

/** Split/normalize a language spec such as `'eng'`, `'chi_sim+eng'`. */
function normalizeLangs(input) {
  const raw = Array.isArray(input) ? input : [input]
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    for (const part of item.split(/[+,\s]+/)) {
      const lang = part.trim()
      if (lang && !out.includes(lang)) out.push(lang)
    }
  }
  return out
}

/** List vendored language files. */
function listLangFiles(langDir) {
  try {
    return readdirSync(langDir).filter((name) => TRAINEDDATA_RE.test(name)).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function langCodeFromFile(name) {
  const match = TRAINEDDATA_RE.exec(name)
  return match ? match[1] : null
}

/** Validate the requested languages against the vendored files. */
function resolveLangData(langDir, langs) {
  if (!existsSync(langDir)) {
    throw ocrError('OCR_LANG_DIR', `OCR language data directory not found: ${langDir}`)
  }
  const files = new Set(listLangFiles(langDir))
  const missing = []
  for (const lang of langs) {
    if (!LANG_CODE_RE.test(lang)) {
      throw ocrError('OCR_LANG_INVALID', `Invalid OCR language code "${lang}"`)
    }
    if (!files.has(`${lang}.traineddata.gz`) && !files.has(`${lang}.traineddata`)) missing.push(lang)
  }
  if (missing.length > 0) {
    const available = listLangFiles(langDir).map(langCodeFromFile).filter(Boolean)
    throw ocrError(
      'OCR_LANG_MISSING',
      `OCR language data missing for ${missing.join(', ')} in ${langDir}. ` +
        `Available: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    )
  }
}

/** Detect the container format from magic bytes; null when unrecognized. */
function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'png'
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpeg'
  if (
    buffer.length >= 6 &&
    (buffer.toString('latin1', 0, 6) === 'GIF87a' || buffer.toString('latin1', 0, 6) === 'GIF89a')
  ) return 'gif'
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) return 'webp'
  return null
}

function normalizeMime(mime) {
  if (typeof mime !== 'string') return null
  const trimmed = mime.trim().toLowerCase()
  if (!trimmed) return null
  return MIME_ALIASES[trimmed] || null
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

/** Best-effort pixel dimensions for the common screenshot formats. */
function imageSize(buffer, type) {
  try {
    if (type === 'png' && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (type === 'gif' && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    }
    if (type === 'jpeg') {
      const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1
          continue
        }
        let marker = buffer[offset + 1]
        while (marker === 0xff) {
          offset += 1
          marker = buffer[offset + 1]
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2
          continue
        }
        const segmentLength = buffer.readUInt16BE(offset + 2)
        if (sof.has(marker)) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
        }
        offset += 2 + segmentLength
      }
      return {}
    }
    if (type === 'webp' && buffer.length >= 30) {
      const chunk = buffer.toString('latin1', 12, 16)
      if (chunk === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
      }
      if (chunk === 'VP8L' && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      if (chunk === 'VP8X') {
        return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 }
      }
      return {}
    }
  } catch {
    /* dimensions are a nicety, never a failure */
  }
  return {}
}

/**
 * Decode + validate an image payload.
 * @returns `{ buffer, base64, mime, width?, height? }`.
 */
function decodeImage(input) {
  if (!input || typeof input !== 'object') {
    throw ocrError('OCR_INVALID_INPUT', 'OCR input must be an object: { base64, mime?, langs? }')
  }
  const { base64, mime } = input
  if (typeof base64 !== 'string' || base64.trim() === '') {
    throw ocrError('OCR_EMPTY_INPUT', 'OCR input is empty: drop a PNG, JPEG, WEBP or GIF image')
  }

  let raw = base64.trim()
  let declaredMime = normalizeMime(mime)

  const dataUrl = /^data:([^;,]+)(?:;[^;,]+)*;base64,(.*)$/is.exec(raw)
  if (dataUrl) {
    if (!declaredMime && dataUrl[1]) declaredMime = normalizeMime(dataUrl[1])
    raw = dataUrl[2]
  } else if (/^data:/i.test(raw)) {
    throw ocrError('OCR_INVALID_BASE64', 'Unsupported data URL: expected "data:image/<type>;base64,<data>"')
  }

  if (mime !== undefined && mime !== null && mime !== '' && !declaredMime) {
    throw ocrError('OCR_INVALID_MIME', `Unsupported image MIME type "${mime}"`)
  }

  raw = raw.replace(/\s+/g, '')
  if (raw === '') throw ocrError('OCR_EMPTY_INPUT', 'OCR input is empty after removing whitespace')
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) {
    throw ocrError('OCR_INVALID_BASE64', 'Invalid OCR image data: unexpected base64 characters')
  }
  if (raw.length % 4 === 1) {
    throw ocrError('OCR_INVALID_BASE64', 'Invalid OCR image data: truncated base64 payload')
  }

  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length === 0) throw ocrError('OCR_INVALID_BASE64', 'Invalid OCR image data: decoded to zero bytes')
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw ocrError('OCR_IMAGE_TOO_LARGE', `OCR image is too large (${buffer.length} bytes)`)
  }

  const type = detectImageType(buffer)
  if (!type) {
    throw ocrError('OCR_INVALID_IMAGE', 'Unsupported image data: magic bytes do not match PNG, JPEG, WEBP or GIF')
  }
  if (declaredMime && declaredMime !== MIME_BY_TYPE[type]) {
    throw ocrError('OCR_MIME_MISMATCH', `Image MIME mismatch: declared ${declaredMime} but bytes look like ${MIME_BY_TYPE[type]}`)
  }
  const size = imageSize(buffer, type)
  return { buffer, base64: raw, mime: MIME_BY_TYPE[type], ...size }
}

/** Locate a working system Node binary once. */
function resolveNode(explicit, log) {
  const candidates = [explicit, process.env.JSON_STUDIO_NODE, 'node', 'node.exe'].filter(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  )
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-v'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      if (probe.status === 0) {
        log(`[ocr] node binary: ${candidate} (${String(probe.stdout).trim()})`)
        return candidate
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/**
 * Create the OCR engine facade.
 * @param {{ langDir?: string, defaultLangs?: string, nodePath?: string, logger?: Function | object }} [options]
 */
export function createOcrEngine(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const langDir = opts.langDir ? path.resolve(String(opts.langDir)) : fileURLToPath(new URL('../assets/lang', import.meta.url))
  const defaultLangs = normalizeLangs(opts.defaultLangs ?? 'eng')
  const log = makeLogSink(opts.logger)
  const cacheDir = process.env.JSON_STUDIO_OCR_CACHE || path.join(process.env.TEMP || process.env.TMP || '.', 'json-studio-ocr')

  let nodeCommand = null
  let nodeChecked = false
  let child = null
  let childPid = null
  let nextId = 1
  const pending = new Map()
  let disposed = false
  let queue = Promise.resolve()

  const enqueue = (task) => {
    const run = queue.then(task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const failPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const stopChild = () => {
    const current = child
    child = null
    childPid = null
    if (!current) return Promise.resolve()
    try {
      current.kill()
    } catch {
      /* already gone */
    }
    return Promise.resolve()
  }

  const ensureNode = () => {
    if (!nodeChecked) {
      nodeChecked = true
      nodeCommand = resolveNode(opts.nodePath, log)
    }
    if (!nodeCommand) {
      throw ocrError('OCR_NODE_MISSING', 'No system Node.js binary found for the OCR worker (set JSON_STUDIO_NODE)')
    }
    return nodeCommand
  }

  /** Start the worker process and wire its protocol. */
  const startChild = () => {
    const command = ensureNode()
    child = spawn(command, [WORKER_PATH, langDir], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, JSON_STUDIO_OCR_CACHE: cacheDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    childPid = child.pid ?? null
    const current = child
    log(`[ocr] worker started (pid ${childPid})`)

    const lines = createInterface({ input: current.stdout })
    lines.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        log(`[ocr] ignoring worker line: ${line.slice(0, 120)}`)
        return
      }
      if (message && message.ready === true) return
      if (!message || message.id === undefined) return
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok === true) entry.resolve(message)
      else {
        const failure = message.error || {}
        entry.reject(ocrError(failure.code || 'OCR_RECOGNIZE', failure.message || 'OCR failed'))
      }
    })

    current.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text.length > 0) log(`[ocr] ${text.slice(0, 400)}`)
    })
    current.on('error', (error) => {
      log(`[ocr] worker process error: ${errorMessage(error)}`)
    })
    current.on('exit', (code, signal) => {
      log(`[ocr] worker exited (${code ?? signal})`)
      if (child === current) {
        child = null
        childPid = null
      }
      failPending(ocrError('OCR_WORKER_EXIT', `OCR worker exited (${code ?? signal ?? 'unknown'})`))
    })
    return current
  }

  const ensureChild = () => {
    if (child && child.exitCode === null && child.signalCode === null) return child
    return startChild()
  }

  /** Send one request and wait for its reply. */
  const request = (payload) => new Promise((resolve, reject) => {
    const processHandle = ensureChild()
    const id = nextId
    nextId += 1
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(ocrError('OCR_TIMEOUT', `OCR worker did not answer within ${REQUEST_TIMEOUT_MS} ms`))
      stopChild()
    }, REQUEST_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    pending.set(id, { resolve, reject, timer })
    try {
      processHandle.stdin.write(`${JSON.stringify({ id, ...payload })}\n`)
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      stopChild()
      reject(ocrError('OCR_WORKER_WRITE', `Could not reach the OCR worker: ${errorMessage(error)}`))
    }
  })

  async function runRecognize(input) {
    if (disposed) throw ocrError('OCR_DISPOSED', 'OCR engine has been disposed')
    const started = Date.now()
    const image = decodeImage(input)
    const requested = normalizeLangs(input.langs ?? defaultLangs)
    if (requested.length === 0) throw ocrError('OCR_LANG_INVALID', 'No OCR language was requested')
    resolveLangData(langDir, requested)

    const reply = await request({ base64: image.base64, langs: requested.join('+') })
    return {
      text: typeof reply.text === 'string' ? reply.text : '',
      confidence: typeof reply.confidence === 'number' ? reply.confidence : 0,
      langs: reply.langs || requested.join('+'),
      ms: typeof reply.ms === 'number' ? reply.ms : Date.now() - started,
      ...(Number.isFinite(image.width) && image.width > 0 ? { width: image.width } : {}),
      ...(Number.isFinite(image.height) && image.height > 0 ? { height: image.height } : {}),
    }
  }

  function recognize(input) {
    if (disposed) return Promise.reject(ocrError('OCR_DISPOSED', 'OCR engine has been disposed'))
    return enqueue(() => runRecognize(input))
  }

  function describe() {
    const langFiles = listLangFiles(langDir)
    const langs = []
    for (const file of langFiles) {
      const code = langCodeFromFile(file)
      if (code && !langs.includes(code)) langs.push(code)
    }
    return {
      ready: child !== null && !disposed,
      engine: ENGINE,
      langs,
      langFiles,
      node: nodeCommand,
      pid: childPid,
      worker: 'src/ocr-worker.mjs',
    }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    await queue.catch(() => {})
    failPending(ocrError('OCR_DISPOSED', 'OCR engine has been disposed'))
    if (child) {
      try {
        child.stdin.write(`${JSON.stringify({ command: 'dispose' })}\n`)
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
      await stopChild()
    }
  }

  return { recognize, describe, dispose }
}
