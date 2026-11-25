/**
 * OCR worker process for JSON Studio.
 *
 * Spawned by `src/ocr.js` with the system Node binary, because the Harness Host
 * runs under a filesystem view that cannot read the plugin's `node_modules`.
 * A plain Node child resolves `tesseract.js` from the plugin directory normally.
 *
 * Protocol: one JSON object per line on stdin/stdout.
 *   → { id, base64, langs }
 *   ← { id, ok: true, text, confidence, ms, width, height, langs }
 *   ← { id, ok: false, error: { message, code } }
 *   → { command: 'dispose' }
 * Anything the worker logs goes to stderr, never stdout.
 */
import { existsSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'

const langDir = process.argv[2] || ''
const log = (message) => {
  try {
    process.stderr.write(`[json-studio-ocr] ${message}\n`)
  } catch {
    /* stderr is best effort */
  }
}

let tesseractModule
let worker = null
let workerLangs = ''

const PAGESEG_MODE = '6'
const PRESERVE_INTERWORD_SPACES = '1'

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch (error) {
    log(`stdout write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function langCodes() {
  try {
    return readdirSync(langDir)
      .map((name) => /^(.*)\.traineddata(?:\.gz)?$/.exec(name))
      .filter(Boolean)
      .map((match) => match[1])
  } catch {
    return []
  }
}

function normalizeLangs(value) {
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    for (const part of item.split(/[+,\s]+/)) {
      if (part && !out.includes(part)) out.push(part)
    }
  }
  return out
}

async function ensureWorker(langs) {
  if (!tesseractModule) {
    tesseractModule = await import('tesseract.js')
  }
  const { createWorker, OEM } = tesseractModule
  const key = langs.join('+')
  if (worker && key === workerLangs) return worker
  if (worker) {
    try {
      await worker.reinitialize(key)
      await worker.setParameters({
        tessedit_pageseg_mode: PAGESEG_MODE,
        preserve_interword_spaces: PRESERVE_INTERWORD_SPACES,
      })
      workerLangs = key
      return worker
    } catch (error) {
      log(`language switch failed: ${error instanceof Error ? error.message : String(error)}`)
      try {
        await worker.terminate()
      } catch {
        /* ignore */
      }
      worker = null
      workerLangs = ''
    }
  }
  log(`creating worker for ${key}`)
  worker = await createWorker(key, OEM.LSTM_ONLY, {
    langPath: langDir,
    gzip: true,
    cachePath: process.env.JSON_STUDIO_OCR_CACHE || undefined,
    logger: (message) => log(`${message.status}: ${Math.round((message.progress || 0) * 100)}%`),
    errorHandler: (error) => log(`worker error: ${error instanceof Error ? error.message : String(error)}`),
  })
  await worker.setParameters({
    tessedit_pageseg_mode: PAGESEG_MODE,
    preserve_interword_spaces: PRESERVE_INTERWORD_SPACES,
  })
  workerLangs = key
  return worker
}

function trimText(raw) {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

async function recognize(id, request) {
  const started = Date.now()
  const langs = normalizeLangs(request.langs)
  if (langs.length === 0) throw Object.assign(new Error('no OCR language requested'), { code: 'OCR_LANG_INVALID' })
  const available = langCodes()
  for (const lang of langs) {
    if (!available.includes(lang)) {
      throw Object.assign(new Error(`missing traineddata for "${lang}" in ${langDir}`), { code: 'OCR_LANG_MISSING' })
    }
  }
  const buffer = Buffer.from(String(request.base64 ?? ''), 'base64')
  if (buffer.length === 0) throw Object.assign(new Error('empty image'), { code: 'OCR_EMPTY_INPUT' })
  const active = await ensureWorker(langs)
  const result = await active.recognize(buffer, {}, { text: true })
  const data = result && result.data ? result.data : {}
  const confidence = Number(data.confidence)
  send({
    id,
    ok: true,
    text: trimText(data.text),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 0,
    langs: langs.join('+'),
    ms: Date.now() - started,
  })
}

async function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log('ignoring non-JSON stdin line')
    return
  }
  if (message && message.command === 'dispose') {
    await shutdown(0)
    return
  }
  if (!message || message.id === undefined) return
  try {
    await recognize(message.id, message)
  } catch (error) {
    send({
      id: message.id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error.code === 'string' ? error.code : 'OCR_RECOGNIZE',
      },
    })
  }
}

async function shutdown(code) {
  if (worker) {
    try {
      await worker.terminate()
    } catch {
      /* ignore */
    }
    worker = null
  }
  process.exit(code)
}

process.on('uncaughtException', (error) => {
  log(`uncaught: ${error instanceof Error ? error.stack || error.message : String(error)}`)
})
process.on('unhandledRejection', (error) => {
  log(`unhandled: ${error instanceof Error ? error.stack || error.message : String(error)}`)
})
process.on('SIGTERM', () => {
  shutdown(0)
})
process.on('SIGINT', () => {
  shutdown(0)
})

if (langDir && !existsSync(langDir)) log(`language directory not found: ${langDir}`)
log(`worker started (langs: ${langCodes().join(',')})`)
send({ ready: true, langs: langCodes() })

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  handle(line)
})
lines.on('close', () => {
  shutdown(0)
})
