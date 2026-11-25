/**
 * JSON Studio — host half.
 *
 * The panel is a browser plugin (`client.js`) that formats JSON entirely on the
 * client. The only thing the browser cannot do is read text out of an image, so
 * this row owns two small HTTP routes under `/json-studio`:
 *
 *   GET  /json-studio/status  — what this plugin actually registered.
 *   POST /json-studio/ocr     — `{ image, mime?, langs? }` → `{ text, ... }`.
 *
 * OCR runs in-process on the host with a vendored `tesseract.js` + traineddata,
 * so the feature works offline and never needs a browser worker or a CDN.
 * @module @local/dsh-json-studio
 */
import { statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOcrEngine } from './src/ocr.js'

/** Loader id of this plugin. */
export const name = 'json-studio'

/** Package name; also the browser module id and the client-module graph row key. */
const PACKAGE = '@local/dsh-json-studio'

/** Host services that must be up before the route can register. */
export const inject = ['webServer']

/** Browser route prefix owned by this plugin. */
const ROUTE = '/json-studio'

/** Default accepted image size, in bytes (12 MiB before base64 expansion). */
const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024

/** Default in-app shortcut that opens the panel with the current selection. */
const DEFAULT_SHORTCUT = 'Ctrl+Alt+J'

/**
 * Resolve deployment knobs from the patch row, ignoring nonsense values.
 * @param raw - the Loader row's config.
 * @returns normalized limits and language preference.
 */
function resolveConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const maxImageBytes = Number.isFinite(value.maxImageBytes) && value.maxImageBytes > 0
    ? Math.floor(value.maxImageBytes)
    : DEFAULT_MAX_IMAGE_BYTES
  const shortcut = typeof value.shortcut === 'string' && /^[A-Za-z0-9+]+$/u.test(value.shortcut.trim())
    ? value.shortcut.trim()
    : DEFAULT_SHORTCUT
  return {
    maxImageBytes,
    ocrLangs: typeof value.ocrLangs === 'string' && value.ocrLangs.trim().length > 0
      ? value.ocrLangs.trim()
      : 'eng',
    shortcut,
    watchClientBundle: value.watchClientBundle !== false,
    clientPollMs: Number.isFinite(value.clientPollMs) && value.clientPollMs >= 50 ? value.clientPollMs : 300,
    devLab: value.devLab === true,
  }
}

/** Files the development lab page can load, mapped to package-relative paths. */
const LAB_ASSETS = {
  'react.js': 'react.development.js',
  'react-dom.js': 'react-dom.development.js',
  'client.js': '../client.js',
  'ocr-sample.png': '../test/fixtures/ocr/json-clean-900x420.png',
}

/** Content types used by the development lab route. */
const LAB_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
}

/**
 * Read a file through the system Node binary. The Harness Host runs under a
 * filesystem view that does not always observe files written by external tools
 * (pnpm, build scripts); a plain `node` child does. Used by the development lab
 * and by the one-time browser-bundle registration. The path is always a fixed
 * package location, never a request-controlled path.
 * @param file - absolute path.
 * @returns the file bytes.
 */
function readRealFile(file) {
  const script = `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(file)}))`
  return execFileSync('node', ['-e', script], { maxBuffer: 64 * 1024 * 1024 })
}

/** @returns a JSON response with no caching and a byte-accurate length. */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * @param req - node request.
 * @param limit - ceiling in bytes.
 * @returns the parsed JSON body.
 * @throws when the body is too large or not JSON.
 */
async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`request body is over ${limit} bytes`)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

/**
 * Build the `/json-studio` handler.
 * @param engine - the OCR engine.
 * @param config - normalized config.
 * @param describe - reads this plugin's live state back from the host.
 */
function createHandler(engine, config, describe, labDir) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname.replace(/\/+$/u, '')
    try {
      if (config.devLab && (pathname === `${ROUTE}/lab` || pathname.startsWith(`${ROUTE}/lab/`))) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: `${req.method} is not allowed here` })
          return
        }
        const relative = pathname.slice(`${ROUTE}/lab`.length).replace(/^\/+/u, '')
        if (relative === 'register') {
          // Development helper: publish a build written by external tooling into
          // the Host's filesystem view. No-op content-wise, but it registers the
          // file so `clientModules` can serve the fresh bundle.
          const file = path.join(labDir, '..', 'client.js')
          const data = readRealFile(file)
          await writeFile(file, data)
          sendJson(res, 200, { ok: true, bytes: data.length })
          return
        }
        const target = relative === '' ? 'index.html' : LAB_ASSETS[relative]
        if (!target) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        const file = path.resolve(labDir, target)
        if (!file.startsWith(labDir) && !file.startsWith(path.resolve(labDir, '..'))) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const data = relative === 'client.js' || relative.startsWith('react') || relative === 'ocr-sample.png'
          ? readRealFile(file)
          : await readFile(file)
        res.writeHead(200, {
          'content-type': LAB_MIME[path.extname(file)] || 'application/octet-stream',
          'content-length': data.length,
          'cache-control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : data)
        return
      }

      if (pathname === `${ROUTE}/status`) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: `${req.method} is not allowed here` })
          return
        }
        sendJson(res, 200, { ok: true, name, package: PACKAGE, ...describe() })
        return
      }

      if (pathname === `${ROUTE}/ocr`) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: `${req.method} is not allowed here` })
          return
        }
        const body = await readJsonBody(req, Math.ceil(config.maxImageBytes * 1.4) + 262144)
        const image = typeof body.image === 'string' ? body.image.trim() : ''
        if (image.length === 0) {
          sendJson(res, 400, { ok: false, error: 'missing image' })
          return
        }
        const decodedBytes = Math.floor(image.length * 0.75)
        if (decodedBytes > config.maxImageBytes) {
          sendJson(res, 413, {
            ok: false,
            error: `image is larger than the ${config.maxImageBytes}-byte limit`,
            maxImageBytes: config.maxImageBytes,
          })
          return
        }
        const started = Date.now()
        const result = await engine.recognize({
          base64: image,
          mime: typeof body.mime === 'string' ? body.mime : undefined,
          langs: typeof body.langs === 'string' && body.langs.trim().length > 0 ? body.langs.trim() : config.ocrLangs,
        })
        sendJson(res, 200, {
          ok: true,
          text: result.text,
          confidence: result.confidence,
          langs: result.langs ?? config.ocrLangs,
          width: result.width,
          height: result.height,
          ms: result.ms ?? Date.now() - started,
          engine: 'tesseract.js',
        })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400
      sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Register the OCR route and keep the browser bundle live after edits.
 * @param ctx - the host plugin context.
 * @param config - the Loader row's config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  /** Absolute directory holding the vendored traineddata files. */
  const langDir = fileURLToPath(new URL('./assets/lang/', import.meta.url))
  /** Absolute directory holding the development lab page. */
  const labDir = fileURLToPath(new URL('./lab/', import.meta.url))
  const engine = createOcrEngine({ langDir, defaultLangs: resolved.ocrLangs })
  const startedAt = Date.now()

  ctx.effect(() => () => engine.dispose(), 'json-studio: ocr engine')

  /** Absolute path of this package's browser bundle. */
  const bundlePath = fileURLToPath(new URL('./client.js', import.meta.url))

  // The Harness Host runs under a filesystem view that may not observe a bundle
  // written by external build tooling (build.mjs). Reading it through a plain
  // Node child does; writing it back through this process registers it in the
  // Host view so the Web client can load it. No-op when the bundle is visible.
  const ensureBundleVisible = () => {
    try {
      statSync(bundlePath)
      return
    } catch {
      /* invisible to this process until registered */
    }
    import('node:fs/promises').then(async ({ writeFile }) => {
      try {
        const data = readRealFile(bundlePath)
        await writeFile(bundlePath, data)
        ctx.logger?.info?.(`json-studio: registered browser bundle (${data.length} bytes)`)
      } catch (error) {
        ctx.logger?.warn?.(`json-studio: cannot register browser bundle: ${error instanceof Error ? error.message : String(error)}`)
      }
    }).catch(() => {})
  }
  ensureBundleVisible()
  /** Observable state of the client-bundle watch, reported by the status route. */
  const watchState = { bundle: bundlePath, watching: false, ticks: 0, published: 0, lastError: '' }

  /** @returns reload-relevant metadata of the client bundle, or undefined. */
  const bundleStat = () => {
    try {
      const info = statSync(bundlePath)
      return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size }
    } catch {
      return undefined
    }
  }

  const describe = () => ({
    version: '1.3.0',
    route: ROUTE,
    uptimeMs: Date.now() - startedAt,
    maxImageBytes: resolved.maxImageBytes,
    shortcut: resolved.shortcut,
    devLab: resolved.devLab,
    client: {
      path: bundlePath,
      bytes: (() => {
        try {
          return statSync(bundlePath).size
        } catch {
          return null
        }
      })(),
      watch: { ...watchState },
    },
    ocr: engine.describe(),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: createHandler(engine, resolved, describe, labDir),
    }),
    `json-studio: ${ROUTE}`,
  )

  // Keep the browser half live: editing client.js reaches an open page without a
  // Harness restart. The graph accepts a bundle change through exactly one door —
  // clientModules.rebuilt() — and the browser-side HMR plugin swaps the plugin when
  // the resulting `rebuilt` frame arrives over /plugins/events.
  if (resolved.watchClientBundle) {
    ctx.inject(['clientModules'], (scope) => {
      let last = bundleStat()
      const timer = setInterval(() => {
        const current = bundleStat()
        watchState.ticks += 1
        if (current === undefined) return
        if (last !== undefined
          && current.mtimeMs === last.mtimeMs
          && current.ctimeMs === last.ctimeMs
          && current.size === last.size) return
        last = current
        try {
          scope.clientModules.rebuilt(PACKAGE)
          watchState.published += 1
          watchState.lastError = ''
        } catch (error) {
          watchState.lastError = error instanceof Error ? error.message : String(error)
        }
      }, resolved.clientPollMs)
      timer.unref?.()
      watchState.watching = true
      scope.effect(() => () => {
        clearInterval(timer)
        watchState.watching = false
      }, 'json-studio: client bundle watch')
    })
  }

  ctx.logger?.info?.(
    `json-studio: ready — route ${ROUTE}, langs ${resolved.ocrLangs}, langDir ${path.basename(langDir)}, bundle ${path.basename(bundlePath)}`,
  )
}
