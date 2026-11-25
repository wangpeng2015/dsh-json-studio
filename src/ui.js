/**
 * JSON Studio — browser half.
 *
 * One full-width main panel plus its left-sidebar icon. Formatting is entirely
 * local (the tolerant engine is inlined by build.mjs); the only host call is
 * `POST /json-studio/ocr` when the user drops an image.
 */

/** Panel identity shared by the sidebar row and the page it opens. */
const PANEL_ID = 'json-studio'

/** Locale namespace owned by this plugin. */
const NS = 'local.json-studio'

/** localStorage key for the draft and view preferences. */
const STORE_KEY = 'json-studio.v1'

/** Host routes. */
const OCR_ENDPOINT = '/json-studio/ocr'
const STATUS_ENDPOINT = '/json-studio/status'

/** Client-side ceilings that keep the page responsive. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_CODE_LINES = 4000
const MAX_HIGHLIGHT_CHARS = 240000
const MAX_TABLE_ROWS = 2000
const MAX_EXPAND_NODES = 3000

/** Chips shown on the empty state. */
const SAMPLE_CHIPS = ['api', 'json5', 'python', 'broken', 'array']

const SAMPLES = {
  api: `{
  "code": 0,
  "message": "ok",
  "data": {
    "users": [
      { "id": 1, "name": "Ada Lovelace", "role": "admin", "active": true, "score": 98.5 },
      { "id": 2, "name": "Alan Turing", "role": "member", "active": false, "score": 91.2 },
      { "id": 3, "name": "Grace Hopper", "role": "member", "active": true, "score": 87.9 }
    ],
    "total": 3,
    "page": 1,
    "hasMore": null
  }
}`,
  json5: `// json5-ish config
{
  app: 'json-studio',
  version: 1.2,
  features: ['format', 'tree', 'table',],
  theme: { mode: 'dark', accent: '#7c5cff' },
  retries: 0x3,
  timeout: .5e3,
  enabled: True,
}`,
  python: `{
  'name': 'Ada',
  'skills': ('math', 'logic'),
  'active': True,
  'manager': None,
  'scores': [98, 91, 87],
}`,
  broken: `{"users": [{"id": 1, "name": "Ada", "tags": ["math" "logic"]}, {"id": 2, "name": "Alan", "tags": ["crypto"]},], "total": 2`,
  array: `[
  { "id": "A-100", "name": "Widget", "price": 12.5, "stock": 8, "tags": ["new", "sale"] },
  { "id": "A-101", "name": "Gadget", "price": 99, "stock": 0, "tags": ["limited"] },
  { "id": "A-102", "name": "Doohickey", "price": 7.25, "stock": 42, "tags": [] }
]`,
}

/* ------------------------------------------------------------------ helpers */

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const isContainer = (value) => value !== null && typeof value === 'object'

const typeOf = (value) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const byteLength = (text) => {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    return text.length
  }
}

const numberLabel = (value) => {
  try {
    return Number(value).toLocaleString()
  } catch {
    return String(value)
  }
}

const sizeLabel = (bytes) => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

const truncate = (text, limit) => (text.length > limit ? text.slice(0, limit) + '…' : text)

const childPath = (base, key, array) => {
  if (array) return base + '[' + key + ']'
  return /^[A-Za-z_$][\w$]*$/.test(String(key))
    ? base + '.' + key
    : base + '[' + JSON.stringify(String(key)) + ']'
}

const readStore = () => {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const writeStore = (value) => {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(value))
  } catch {
    /* private mode or quota — preferences are optional */
  }
}

/* ---------------------------------------------------------- shortcut plumbing */

/** Event the shortcut fires so an already-mounted panel adopts the selection. */
const INJECT_EVENT = 'json-studio:inject'

/** Draft slot for a selection made while the panel is not mounted yet. */
const PENDING_KEY = 'json-studio.pending'

/** Shortcut used before the host reports its configured value. */
const DEFAULT_SHORTCUT = 'Ctrl+Alt+J'

/** Largest selection carried into the panel. */
const MAX_SELECTION_CHARS = 2_000_000

/** localStorage key for a user-recorded shortcut override. */
const SHORTCUT_STORE = 'json-studio.shortcut'

/** Event fired when the recorded shortcut changes. */
const SHORTCUT_EVENT = 'json-studio:shortcut'

/** True while the settings page is capturing keys, so the global handler stands down. */
let shortcutRecording = false

/** @returns the recorded shortcut, or an empty string. */
function loadShortcutOverride() {
  try {
    return window.localStorage.getItem(SHORTCUT_STORE) || ''
  } catch {
    return ''
  }
}

/** Persist (or clear, with an empty value) the recorded shortcut and announce it. */
function saveShortcutOverride(spec) {
  try {
    if (spec) window.localStorage.setItem(SHORTCUT_STORE, spec)
    else window.localStorage.removeItem(SHORTCUT_STORE)
  } catch {
    /* recording still applies for this page's lifetime through the event */
  }
  try {
    window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: { shortcut: spec } }))
  } catch {
    /* ignore */
  }
}

/** @returns the effective shortcut: user override, host config, then default. */
function currentShortcut(fallback) {
  return loadShortcutOverride() || fallback || DEFAULT_SHORTCUT
}

/** @returns the spec spelling for one pressed key. */
function shortcutKeyName(event) {
  const key = String(event.key || '')
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}

/** @returns the modifier/key parts of a shortcut such as `Ctrl+Alt+J`. */
function parseShortcut(spec) {
  const parts = String(spec || '').split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const key = parts[parts.length - 1].toLowerCase()
  const mods = parts.slice(0, -1).map((part) => part.toLowerCase())
  return {
    key,
    ctrl: mods.includes('ctrl') || mods.includes('control') || mods.includes('cmd') || mods.includes('meta'),
    alt: mods.includes('alt') || mods.includes('option'),
    shift: mods.includes('shift'),
  }
}

/** @returns whether a keydown matches the configured shortcut. */
function matchesShortcut(event, spec) {
  const parsed = parseShortcut(spec)
  if (!parsed) return false
  const pressed = event.key === ' ' ? 'space' : String(event.key || '').toLowerCase()
  if (pressed !== parsed.key) return false
  if (Boolean(event.altKey) !== parsed.alt) return false
  if (Boolean(event.shiftKey) !== parsed.shift) return false
  return Boolean(event.ctrlKey || event.metaKey) === parsed.ctrl
}

/** @returns the selected text, from the focused field or the page selection. */
function readSelectedText() {
  try {
    const active = document.activeElement
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      const start = active.selectionStart
      const end = active.selectionEnd
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        return String(active.value || '').slice(start, end)
      }
    }
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return String(selection.toString() || '')
  } catch {
    /* selections are best effort */
  }
  return ''
}

const readPendingSelection = () => {
  try {
    return window.localStorage.getItem(PENDING_KEY) || ''
  } catch {
    return ''
  }
}

const clearPendingSelection = () => {
  try {
    window.localStorage.removeItem(PENDING_KEY)
  } catch {
    /* ignore */
  }
}

/** Open the panel and hand it `text`, whether or not it is mounted right now. */
function publishSelection(ctx, text) {
  try {
    window.localStorage.setItem(PENDING_KEY, text)
  } catch {
    /* the in-page event still works for a mounted panel */
  }
  try {
    if (ctx.layout) ctx.layout.selectPanel(PANEL_ID)
  } catch {
    /* the panel is not registered yet; the pending draft is kept */
  }
  try {
    window.dispatchEvent(new CustomEvent(INJECT_EVENT, { detail: { text } }))
  } catch {
    /* ignore */
  }
}

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', 'readonly')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

const downloadText = (text, name) => {
  try {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return true
  } catch {
    return false
  }
}

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result || ''))
  reader.onerror = () => reject(reader.error || new Error('read failed'))
  reader.readAsDataURL(file)
})

/* -------------------------------------------------------------------- icons */

function IconBraces(props) {
  const size = props && props.size ? props.size : 16
  return h('svg', {
    width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block' },
  }, [
    h('path', { key: 'l', d: 'M7.5 3.2c-1.8 0-2.3 1-2.3 2.6v2.1c0 1.2-.6 1.8-1.7 2.1 1.1.3 1.7.9 1.7 2.1v2.1c0 1.6.5 2.6 2.3 2.6' }),
    h('path', { key: 'r', d: 'M12.5 3.2c1.8 0 2.3 1 2.3 2.6v2.1c0 1.2.6 1.8 1.7 2.1-1.1.3-1.7.9-1.7 2.1v2.1c0 1.6-.5 2.6-2.3 2.6' }),
    h('circle', { key: 'a', cx: 10, cy: 10, r: 1.15, fill: 'currentColor', stroke: 'none' }),
  ])
}

const iconProps = (size) => ({
  width: size || 14, height: size || 14, viewBox: '0 0 20 20', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
  strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block' },
})

function IconImage(props) {
  return h('svg', iconProps(props && props.size), [
    h('rect', { key: 'r', x: 2.6, y: 3.4, width: 14.8, height: 13.2, rx: 2.2 }),
    h('circle', { key: 'c', cx: 7.4, cy: 7.8, r: 1.3 }),
    h('path', { key: 'p', d: 'M3.6 14.2l3.9-3.9c.6-.6 1.5-.6 2.1 0l2 2 1.7-1.6c.6-.6 1.5-.6 2.1 0l2.1 2' }),
  ])
}

function IconCopy(props) {
  return h('svg', iconProps(props && props.size), [
    h('rect', { key: 'a', x: 7, y: 7, width: 9.4, height: 9.4, rx: 1.8 }),
    h('path', { key: 'b', d: 'M12.6 6.4V5c0-1-.8-1.8-1.8-1.8H5c-1 0-1.8.8-1.8 1.8v5.8c0 1 .8 1.8 1.8 1.8h1.4' }),
  ])
}

function IconDownload(props) {
  return h('svg', iconProps(props && props.size), [
    h('path', { key: 'a', d: 'M10 3v9' }),
    h('path', { key: 'b', d: 'M6.4 8.7L10 12.3l3.6-3.6' }),
    h('path', { key: 'c', d: 'M4 15.6h12' }),
  ])
}

function IconChevron(props) {
  return h('svg', iconProps(props && props.size), [
    h('path', { key: 'a', d: props && props.open ? 'M5.5 7.8L10 12.2l4.5-4.4' : 'M7.8 5.5l4.4 4.5-4.4 4.5' }),
  ])
}

function IconWrap(props) {
  return h('svg', iconProps(props && props.size), [
    h('path', { key: 'a', d: 'M3.4 6.2h13.2M3.4 10h9.2' }),
    h('path', { key: 'b', d: 'M12.6 10a2.2 2.2 0 1 1 0 4.4H9.4' }),
    h('path', { key: 'c', d: 'M9.2 12.2l-2 2.2 2 2.2' }),
    h('path', { key: 'd', d: 'M3.4 16.6h4.4' }),
  ])
}

function IconTrash(props) {
  return h('svg', iconProps(props && props.size), [
    h('path', { key: 'a', d: 'M3.8 5.6h12.4' }),
    h('path', { key: 'b', d: 'M8 5.6V4.2c0-.6.5-1 1-1h2c.6 0 1 .4 1 1v1.4' }),
    h('path', { key: 'c', d: 'M5.4 5.6l.7 9.6c0 .9.8 1.6 1.7 1.6h4.4c.9 0 1.7-.7 1.7-1.6l.7-9.6' }),
    h('path', { key: 'd', d: 'M8.4 8.8v5M11.6 8.8v5' }),
  ])
}

function IconWand(props) {
  return h('svg', iconProps(props && props.size), [
    h('path', { key: 'a', d: 'M4 16l7.6-7.6' }),
    h('path', { key: 'b', d: 'M12.4 3.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z' }),
    h('path', { key: 'c', d: 'M16.4 8.4l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z' }),
  ])
}

function IconWarning(props) {
  return h('svg', iconProps(props && props.size), [
    h('path', { key: 'a', d: 'M10 3.4l7 12.2H3z' }),
    h('path', { key: 'b', d: 'M10 8.2v3.2' }),
    h('circle', { key: 'c', cx: 10, cy: 13.9, r: 0.85, fill: 'currentColor', stroke: 'none' }),
  ])
}

function SidebarIcon(props) {
  const size = props && props.size ? props.size : 16
  return h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block' },
  }, [
    h('path', { key: 'l', d: 'M6.1 2.6c-1.4 0-1.8.8-1.8 2v1.7c0 1-.5 1.4-1.3 1.7.8.3 1.3.7 1.3 1.7v1.7c0 1.2.4 2 1.8 2' }),
    h('path', { key: 'r', d: 'M9.9 2.6c1.4 0 1.8.8 1.8 2v1.7c0 1 .5 1.4 1.3 1.7-.8.3-1.3.7-1.3 1.7v1.7c0 1.2-.4 2-1.8 2' }),
    h('circle', { key: 'd', cx: 8, cy: 8, r: 1, fill: 'currentColor', stroke: 'none' }),
  ])
}

/* --------------------------------------------------------------- settings page */

function JsonStudioSettings(props) {
  const t = props.t
  const [shortcut, setShortcut] = React.useState(() => currentShortcut(DEFAULT_SHORTCUT))
  const [recording, setRecording] = React.useState(false)
  const [error, setError] = React.useState('')
  const [saved, setSaved] = React.useState('')

  React.useEffect(() => {
    shortcutRecording = recording
    return () => {
      shortcutRecording = false
    }
  }, [recording])

  React.useEffect(() => {
    const onShortcut = (event) => {
      const next = event && event.detail && event.detail.shortcut ? event.detail.shortcut : DEFAULT_SHORTCUT
      setShortcut(next)
      setSaved(t('settingsSaved'))
    }
    window.addEventListener(SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(SHORTCUT_EVENT, onShortcut)
  }, [t])

  React.useEffect(() => {
    if (!recording) return undefined
    const onKeyDown = (event) => {
      if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Dead'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        setError('')
        return
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        setError(t('settingsNeedModifier'))
        return
      }
      const parts = []
      if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      parts.push(shortcutKeyName(event))
      saveShortcutOverride(parts.join('+'))
      setError('')
      setRecording(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [recording, t])

  const reset = () => {
    saveShortcutOverride('')
    setShortcut(DEFAULT_SHORTCUT)
    setError('')
    setSaved(t('settingsReset'))
  }

  return h('div', { className: 'jst-root jst-set-root' }, [
    h('header', { key: 'head', className: 'jst-set-head' }, [
      h('span', { key: 'mark', className: 'jst-mark' }, h(IconBraces, { size: 18 })),
      h('div', { key: 'txt', className: 'jst-set-heading' }, [
        h('h2', { key: 'h', className: 'jst-set-title' }, t('settingsHeading')),
        h('p', { key: 's', className: 'jst-set-sub' }, t('settingsSubtitle')),
      ]),
    ]),
    h('section', { key: 'card', className: 'jst-set-card' }, [
      h('div', { key: 'row', className: 'jst-set-row' }, [
        h('div', { key: 'copy', className: 'jst-set-copy' }, [
          h('div', { key: 'label', className: 'jst-set-label' }, t('settingsShortcut')),
          h('p', { key: 'desc', className: 'jst-set-desc' }, t('settingsShortcutHint')),
        ]),
        h('div', { key: 'actions', className: 'jst-set-actions' }, [
          h('kbd', { key: 'kbd', className: 'jst-kbd' }, shortcut),
          h('button', {
            key: 'record',
            type: 'button',
            className: 'jst-btn' + (recording ? ' jst-btn-primary' : ''),
            onClick: () => {
              setSaved('')
              setError('')
              setRecording(!recording)
            },
          }, recording ? t('settingsRecording') : t('settingsRecord')),
          h('button', {
            key: 'reset', type: 'button', className: 'jst-btn', onClick: reset, title: t('settingsReset'),
          }, t('settingsReset')),
        ]),
      ]),
      error !== '' ? h('p', { key: 'error', className: 'jst-set-error' }, error) : null,
      saved !== '' ? h('p', { key: 'saved', className: 'jst-set-saved' }, saved) : null,
    ]),
    h('p', { key: 'hint', className: 'jst-set-hint' }, t('settingsEscHint')),
  ])
}

/* --------------------------------------------------------------- dictionaries */

const EN = {
  panel: 'JSON Studio',
  tagline: 'format · inspect · OCR',
  input: 'Input',
  output: 'Result',
  format: 'Format',
  minify: 'Minify',
  sortKeys: 'Sort keys',
  escape: 'Escape',
  unescape: 'Unescape',
  sample: 'Sample',
  imageOcr: 'From image',
  clear: 'Clear',
  copy: 'Copy',
  copied: 'Copied to clipboard',
  copyFailed: 'Could not copy',
  download: 'Download',
  wrap: 'Wrap lines',
  viewCode: 'Code',
  viewTree: 'Tree',
  viewTable: 'Table',
  chars: 'chars',
  lines: 'lines',
  bytes: 'bytes',
  nodes: 'nodes',
  depth: 'depth',
  keys: 'keys',
  emptyTitle: 'Paste anything that looks like JSON',
  emptyBody: 'Strict JSON, JSON5, a JS object literal, a Python dict, NDJSON, an escaped string, an array of rows — it will be parsed, repaired, or at least laid out neatly.',
  emptyHint: 'Drop an image anywhere in this panel to read text out of it.',
  inputHint: 'Ctrl/⌘ + Enter formats · Tab indents · images can be pasted',
  shortcutAction: 'opens the selection',
  selectionLoaded: 'Loaded the selected text',
  settingsHeading: 'JSON Studio',
  settingsSubtitle: 'Panel shortcut and behavior',
  settingsShortcut: 'Open with selection',
  settingsShortcutHint: 'Select text anywhere in the Harness, then press this shortcut. The panel opens with the selection; with nothing selected it just opens.',
  settingsRecord: 'Record',
  settingsRecording: 'Press keys…',
  settingsReset: 'Reset',
  settingsNeedModifier: 'Include Ctrl, ⌘ or Alt in the shortcut',
  settingsSaved: 'Shortcut saved',
  settingsEscHint: 'Press Esc to cancel recording. The shortcut works inside the Harness window.',
  modeStrict: 'strict',
  modeRelaxed: 'relaxed',
  modeRepaired: 'repaired',
  modeFallback: 'display only',
  modeStrictHint: 'Valid JSON',
  modeRelaxedHint: 'Valid JSON-like text, normalized',
  modeRepairedHint: 'Recovered with structural repairs',
  modeFallbackHint: 'Cannot be parsed — shown as tidy text',
  notStrictHint: 'Not strict JSON — laid out as readable text below',
  parseError: 'Cannot parse this input',
  atLine: 'line',
  atColumn: 'column',
  locate: 'Go to error',
  notes: 'Notes',
  noteFallback: 'Adjustment',
  noteStripFence: 'Removed code fences',
  noteStripProse: 'Ignored surrounding text',
  noteHeaderFooter: 'Ignored HTTP headers',
  noteComments: 'Removed comments',
  noteSingleQuotes: 'Normalized quotes',
  noteUnquotedKey: 'Quoted bare keys',
  noteTrailingComma: 'Ignored trailing commas',
  notePythonLiterals: 'Mapped Python literals',
  noteNonFinite: 'Mapped non-finite numbers',
  noteLooseNumber: 'Normalized numbers',
  noteEqualsColon: 'Treated “=” as “:”',
  noteMissingComma: 'Inserted missing commas',
  noteBarewordValue: 'Quoted bare values',
  noteTupleArray: 'Treated tuple as array',
  noteSemicolon: 'Ignored semicolons',
  noteTrailingGarbage: 'Ignored trailing text',
  noteJsonpWrapper: 'Unwrapped JSONP callback',
  noteEscapedString: 'Unwrapped escaped JSON string',
  noteDuplicateKey: 'Kept the last duplicate key',
  noteMultipleValues: 'Combined multiple values into an array',
  noteTruncatedInput: 'Recovered a truncated value',
  noteInputTooLarge: 'Input is very large — analysis was bounded',
  noteTooManyNodes: 'Node limit reached',
  noteTooDeep: 'Nesting limit reached',
  noteEmptyInput: 'Input is empty',
  noteBOM: 'Removed byte-order mark',
  noteZeroWidth: 'Removed invisible characters',
  noteSmartQuotes: 'Normalized smart quotes',
  noteNestedJsonDecoded: 'Expanded embedded JSON',
  notePercentDecoded: 'Decoded URL-encoded text',
  noteUnbalancedBrackets: 'Unbalanced brackets',
  noteUnexpectedToken: 'Unexpected token',
  ocrReading: 'Reading text…',
  ocrFromImage: 'Text from image',
  ocrConfidence: 'confidence',
  ocrUndo: 'Undo',
  ocrFailed: 'Could not read the image',
  ocrNotImage: 'That file is not an image',
  ocrTooLarge: 'Image is larger than 12 MB',
  ocrEmpty: 'No text was found in the image',
  ocrLang: 'OCR languages',
  ocrLangEn: 'English',
  ocrLangBoth: 'Chinese + English',
  dropTitle: 'Drop an image to read its text',
  dropBody: 'PNG, JPEG, WebP or GIF · up to 12 MB',
  sampleApi: 'API response',
  sampleJson5: 'JSON5 config',
  samplePython: 'Python dict',
  sampleBroken: 'Broken snippet',
  sampleArray: 'Array of rows',
  tableEmpty: 'Table view needs an array of flat objects',
  tableTooMany: 'Too many rows to show as a table',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  expandDisabled: 'Too many nodes to expand at once',
  copyPath: 'Copy path',
  pathCopied: 'Path copied',
  formatApplied: 'Formatted into the input',
  minifyApplied: 'Minified into the input',
  sortedApplied: 'Keys sorted',
  escapedApplied: 'Escaped as a JSON string',
  unescapedApplied: 'Unescaped',
  nothingToFormat: 'Nothing to format',
  cannotApply: 'This input is not parsed, so that action is unavailable',
  notAString: 'That is not an escaped JSON string',
  largeHighlightOff: 'Large input — syntax highlighting is off',
  largeTruncated: 'Showing the first 4000 lines only',
  root: 'root',
  items: 'items',
  emptyValue: 'empty',
  copiedPath: 'Path copied',
}

const ZH = {
  panel: 'JSON Studio',
  tagline: '格式化 · 树形 · 图片识别',
  input: '输入',
  output: '结果',
  format: '格式化',
  minify: '压缩',
  sortKeys: '键排序',
  escape: '转义',
  unescape: '去转义',
  sample: '示例',
  imageOcr: '图片识别',
  clear: '清空',
  copy: '复制',
  copied: '已复制到剪贴板',
  copyFailed: '复制失败',
  download: '下载',
  wrap: '自动换行',
  viewCode: '源码',
  viewTree: '树形',
  viewTable: '表格',
  chars: '字符',
  lines: '行',
  bytes: '字节',
  nodes: '节点',
  depth: '深度',
  keys: '键',
  emptyTitle: '粘贴任何看起来像 JSON 的内容',
  emptyBody: '标准 JSON、JSON5、JS 对象字面量、Python 字典、NDJSON、被转义的字符串、数组表格——会自动解析、修复，实在不行也会排版得整整齐齐。',
  emptyHint: '在本面板任意位置拖入图片，即可提取图片文字。',
  inputHint: 'Ctrl/⌘ + Enter 格式化 · Tab 缩进 · 可直接粘贴图片',
  shortcutAction: '打开选中内容',
  selectionLoaded: '已载入选中的文本',
  settingsHeading: 'JSON Studio',
  settingsSubtitle: '面板快捷键与行为',
  settingsShortcut: '选中内容后打开',
  settingsShortcutHint: '在 Harness 任意位置选中文本后按下该快捷键，面板会打开并载入选中内容；没有选区时只打开面板。',
  settingsRecord: '录制',
  settingsRecording: '请按组合键…',
  settingsReset: '恢复默认',
  settingsNeedModifier: '快捷键需要包含 Ctrl、⌘ 或 Alt',
  settingsSaved: '快捷键已保存',
  settingsEscHint: '录制时按 Esc 取消。快捷键在 Harness 窗口内生效。',
  modeStrict: '标准',
  modeRelaxed: '宽松',
  modeRepaired: '已修复',
  modeFallback: '仅展示',
  modeStrictHint: '标准 JSON',
  modeRelaxedHint: '类 JSON 文本，已规范化',
  modeRepairedHint: '结构有缺口，已尽量修复',
  modeFallbackHint: '无法解析，已按最佳推测排版展示',
  notStrictHint: '这不是严格 JSON，已在下方尽力排版展示',
  parseError: '无法解析这段内容',
  atLine: '行',
  atColumn: '列',
  locate: '定位错误',
  notes: '提示',
  noteFallback: '自动调整',
  noteStripFence: '已移除代码围栏',
  noteStripProse: '已忽略前后文字',
  noteHeaderFooter: '已忽略 HTTP 头',
  noteComments: '已去除注释',
  noteSingleQuotes: '已统一引号',
  noteUnquotedKey: '已补全键名引号',
  noteTrailingComma: '已忽略尾随逗号',
  notePythonLiterals: '已转换 Python 字面量',
  noteNonFinite: '已转换非有限数值',
  noteLooseNumber: '已规范化数字',
  noteEqualsColon: '已把“=”当作“:”',
  noteMissingComma: '已补全缺失的逗号',
  noteBarewordValue: '已给裸值加引号',
  noteTupleArray: '已将元组当作数组',
  noteSemicolon: '已忽略分号',
  noteTrailingGarbage: '已忽略尾部多余内容',
  noteJsonpWrapper: '已剥掉 JSONP 包装',
  noteEscapedString: '已展开转义 JSON 字符串',
  noteDuplicateKey: '重复键保留最后一个',
  noteMultipleValues: '多个值已合并为数组',
  noteTruncatedInput: '输入被截断，已尽量恢复',
  noteInputTooLarge: '内容过大，分析已截断',
  noteTooManyNodes: '已触及节点上限',
  noteTooDeep: '已触及嵌套上限',
  noteEmptyInput: '输入为空',
  noteBOM: '已移除 BOM',
  noteZeroWidth: '已移除不可见字符',
  noteSmartQuotes: '已替换弯引号',
  noteNestedJsonDecoded: '已展开内嵌 JSON',
  notePercentDecoded: '已解码 URL 编码内容',
  noteUnbalancedBrackets: '括号不匹配',
  noteUnexpectedToken: '意外的标记',
  ocrReading: '正在识别文字…',
  ocrFromImage: '图片文字已提取',
  ocrConfidence: '置信度',
  ocrUndo: '撤销',
  ocrFailed: '图片识别失败',
  ocrNotImage: '这个文件不是图片',
  ocrTooLarge: '图片超过 12 MB',
  ocrEmpty: '图片里没有识别出文字',
  ocrLang: '识别语言',
  ocrLangEn: '英文',
  ocrLangBoth: '中英混合',
  dropTitle: '松开鼠标，提取图片文字',
  dropBody: '支持 PNG / JPEG / WebP / GIF，最大 12 MB',
  sampleApi: 'API 响应',
  sampleJson5: 'JSON5 配置',
  samplePython: 'Python 字典',
  sampleBroken: '损坏片段',
  sampleArray: '数组表格',
  tableEmpty: '表格视图需要「对象数组」',
  tableTooMany: '行数过多，表格视图已关闭',
  expandAll: '全部展开',
  collapseAll: '全部收起',
  expandDisabled: '节点过多，无法一次全部展开',
  copyPath: '复制路径',
  pathCopied: '路径已复制',
  formatApplied: '已格式化到输入框',
  minifyApplied: '已压缩到输入框',
  sortedApplied: '键已排序',
  escapedApplied: '已转义为 JSON 字符串',
  unescapedApplied: '已去转义',
  nothingToFormat: '没有可格式化的内容',
  cannotApply: '当前内容未成功解析，暂不支持该操作',
  notAString: '这不是一段转义字符串',
  largeHighlightOff: '内容较大，已关闭语法高亮',
  largeTruncated: '仅显示前 4000 行',
  root: '根',
  items: '项',
  emptyValue: '空',
  copiedPath: '路径已复制',
}

const NOTE_KEYS = {
  bom: 'noteBOM',
  'smart-quotes': 'noteSmartQuotes',
  'zero-width': 'noteZeroWidth',
  'nested-json-decoded': 'noteNestedJsonDecoded',
  'percent-decoded': 'notePercentDecoded',
  'strip-fence': 'noteStripFence',
  'strip-prose': 'noteStripProse',
  'header-footer': 'noteHeaderFooter',
  comments: 'noteComments',
  'single-quotes': 'noteSingleQuotes',
  'unquoted-key': 'noteUnquotedKey',
  'trailing-comma': 'noteTrailingComma',
  'python-literals': 'notePythonLiterals',
  'non-finite': 'noteNonFinite',
  'loose-number': 'noteLooseNumber',
  'equals-colon': 'noteEqualsColon',
  'missing-comma': 'noteMissingComma',
  'bareword-value': 'noteBarewordValue',
  'tuple-array': 'noteTupleArray',
  semicolon: 'noteSemicolon',
  'trailing-garbage': 'noteTrailingGarbage',
  'jsonp-wrapper': 'noteJsonpWrapper',
  'escaped-string': 'noteEscapedString',
  'duplicate-key': 'noteDuplicateKey',
  'multiple-values': 'noteMultipleValues',
  'truncated-input': 'noteTruncatedInput',
  'input-too-large': 'noteInputTooLarge',
  'too-many-nodes': 'noteTooManyNodes',
  'too-deep': 'noteTooDeep',
  'empty-input': 'noteEmptyInput',
  'unbalanced-brackets': 'noteUnbalancedBrackets',
  'unexpected-token': 'noteUnexpectedToken',
}

const MODE_LABELS = {
  strict: 'modeStrict',
  relaxed: 'modeRelaxed',
  repaired: 'modeRepaired',
  fallback: 'modeFallback',
}

const MODE_HINTS = {
  strict: 'modeStrictHint',
  relaxed: 'modeRelaxedHint',
  repaired: 'modeRepairedHint',
  fallback: 'modeFallbackHint',
}

/* ------------------------------------------------------------------- theme */

function useThemeMode() {
  const [mode, setMode] = React.useState('light')
  React.useEffect(() => {
    const read = () => {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
        const match = raw.match(/rgba?\(([^)]+)\)/i)
        if (!match) return
        const parts = match[1].split(/[,\s/]+/).map(Number)
        if (parts.length < 3 || parts.slice(0, 3).some((value) => !Number.isFinite(value))) return
        const luminance = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255
        setMode(luminance < 0.5 ? 'dark' : 'light')
      } catch {
        /* keep the current mode */
      }
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    let media
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
      media.addEventListener('change', read)
    } catch {
      media = undefined
    }
    return () => {
      observer.disconnect()
      if (media) media.removeEventListener('change', read)
    }
  }, [])
  return mode
}

function useDebouncedValue(value, delay) {
  const [settled, setSettled] = React.useState(value)
  React.useEffect(() => {
    if (value === settled) return undefined
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay, settled])
  return settled
}

/* ------------------------------------------------------------------- pieces */

function ModeBadge(props) {
  const t = props.t
  const mode = props.mode
  const label = MODE_LABELS[mode] ? t(MODE_LABELS[mode]) : mode
  return h('span', {
    className: 'jst-mode jst-mode-' + mode,
    title: MODE_HINTS[mode] ? t(MODE_HINTS[mode]) : '',
  }, h('span', { className: 'jst-dot' }), label)
}

function Notes(props) {
  const t = props.t
  const notes = props.notes || []
  if (notes.length === 0) return null
  return h('div', { className: 'jst-notes' }, notes.slice(0, 8).map((note, index) => {
    const key = NOTE_KEYS[note.code]
    const label = key ? t(key) : (t('noteFallback') + ' · ' + note.code)
    return h('span', {
      key: note.code + ':' + index,
      className: 'jst-note',
      title: note.detail ? label + ' — ' + note.detail : label,
    }, label)
  }))
}

function EmptyState(props) {
  const t = props.t
  const onSample = props.onSample
  return h('div', { className: 'jst-empty' }, [
    h('div', { key: 'mark', className: 'jst-empty-mark' }, h(IconBraces, { size: 34 })),
    h('h2', { key: 'title', className: 'jst-empty-title' }, t('emptyTitle')),
    h('p', { key: 'body', className: 'jst-empty-body' }, t('emptyBody')),
    h('div', { key: 'chips', className: 'jst-chips' }, SAMPLE_CHIPS.map((chip) => h('button', {
      key: chip,
      type: 'button',
      className: 'jst-chip',
      onClick: () => onSample(chip),
    }, t('sample' + chip.charAt(0).toUpperCase() + chip.slice(1))))),
    h('p', { key: 'hint', className: 'jst-empty-hint' }, t('emptyHint')),
    props.shortcut ? h('p', { key: 'shortcut', className: 'jst-empty-hint' }, props.shortcut + ' ' + t('shortcutAction')) : null,
  ])
}

function CodeView(props) {
  const t = props.t
  const text = props.text
  const wrap = props.wrap
  const errorLine = props.errorLine
  const locateSeq = props.locateSeq
  const containerRef = React.useRef(null)
  const highlight = text.length <= MAX_HIGHLIGHT_CHARS
  const lines = React.useMemo(() => {
    if (!text) return []
    if (!highlight) return text.split('\n').map((line) => [{ type: 'plain', text: line }])
    const tokens = tokenizeJson(text)
    const result = [[]]
    for (const token of tokens) {
      const parts = String(token.value).split('\n')
      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) result.push([])
        if (parts[index].length > 0) result[result.length - 1].push({ type: token.type, text: parts[index] })
      }
    }
    return result
  }, [text, highlight])
  const shown = lines.length > MAX_CODE_LINES ? lines.slice(0, MAX_CODE_LINES) : lines

  React.useEffect(() => {
    if (!locateSeq || !errorLine) return
    const host = containerRef.current
    if (!host) return
    const row = host.querySelector('[data-line="' + errorLine + '"]')
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' })
  }, [locateSeq, errorLine])

  if (!text) {
    return h('div', { className: 'jst-empty jst-empty-small' }, h('p', null, t('nothingToFormat')))
  }

  return h('div', { className: 'jst-code-wrap', ref: containerRef }, [
    h('pre', { key: 'code', className: 'jst-code' + (wrap ? ' jst-wrap' : '') }, h('code', null, shown.map((line, lineIndex) => h('div', {
      key: lineIndex,
      className: 'jst-line' + (errorLine === lineIndex + 1 ? ' jst-line-error' : ''),
      'data-line': lineIndex + 1,
    }, [
      h('span', { key: 'ln', className: 'jst-ln' }, lineIndex + 1),
      h('span', { key: 'body', className: 'jst-line-body' }, line.length === 0
        ? h('span', { className: 'jst-tok' }, '\u200b')
        : line.map((segment, segmentIndex) => h('span', {
          key: segmentIndex,
          className: 'jst-tok jst-tok-' + segment.type,
        }, segment.text))),
    ])))),
    !highlight ? h('div', { key: 'note1', className: 'jst-view-note' }, t('largeHighlightOff')) : null,
    lines.length > MAX_CODE_LINES ? h('div', { key: 'note2', className: 'jst-view-note' }, t('largeTruncated')) : null,
  ])
}

function valuePreview(value) {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(value)
    } catch {
      return '"' + value + '"'
    }
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : String(value)
  if (typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return String(value)
}

function TreeNode(props) {
  const t = props.t
  const value = props.value
  const name = props.name
  const path = props.path
  const depth = props.depth
  const array = Array.isArray(value)
  const container = isContainer(value)
  const size = container ? (array ? value.length : Object.keys(value).length) : 0
  const initialOpen = depth === 0 || (depth === 1 && size <= 24)
  const openState = React.useState(initialOpen)
  const open = openState[0]
  const setOpen = openState[1]
  const expandSeq = props.expandSeq
  const expandMode = props.expandMode

  React.useEffect(() => {
    if (!container || expandSeq === 0) return
    setOpen(expandMode === 'all')
  }, [expandSeq, expandMode, container])

  const rows = []
  rows.push(h('div', {
    key: 'row',
    className: 'jst-node' + (container ? ' jst-node-container' : ''),
    style: { paddingLeft: 8 + depth * 14 },
  }, [
    container
      ? h('button', {
        key: 'chev',
        type: 'button',
        className: 'jst-chev',
        onClick: () => setOpen(!open),
        'aria-label': open ? t('collapseAll') : t('expandAll'),
        'aria-expanded': open,
      }, h(IconChevron, { open, size: 12 }))
      : h('span', { key: 'chev', className: 'jst-chev jst-chev-empty' }),
    h('span', { key: 'name', className: 'jst-node-name' }, name),
    h('span', { key: 'colon', className: 'jst-colon' }, ':'),
    container
      ? h('span', { key: 'badge', className: 'jst-type ' + (array ? 'jst-type-array' : 'jst-type-object') }, (array ? '[' : '{') + ' ' + size + ' ' + t('items') + ' ' + (array ? ']' : '}'))
      : h('span', { key: 'val', className: 'jst-val jst-val-' + typeOf(value), title: typeof value === 'string' ? value : undefined }, valuePreview(value)),
    h('button', {
      key: 'copy',
      type: 'button',
      className: 'jst-path',
      title: path,
      onClick: () => props.onCopyPath(path),
    }, h(IconCopy, { size: 11 })),
  ]))

  if (container && open) {
    const keys = array ? value.map((_, index) => index) : Object.keys(value)
    rows.push(h('div', { key: 'children', className: 'jst-children' }, keys.map((key) => h(TreeNode, {
      key: String(key),
      t,
      name: array ? String(key) : key,
      value: value[key],
      path: childPath(path, key, array),
      depth: depth + 1,
      expandSeq,
      expandMode,
      onCopyPath: props.onCopyPath,
    }))))
  }
  return rows
}

function TreeView(props) {
  const t = props.t
  const value = props.value
  const nodes = props.nodes || 0
  const [expand, setExpand] = React.useState({ seq: 0, mode: 'all' })
  const disabled = nodes > MAX_EXPAND_NODES
  return h('div', { className: 'jst-tree' }, [
    h('div', { key: 'bar', className: 'jst-tree-bar' }, [
      h('button', {
        key: 'all', type: 'button', className: 'jst-mini', disabled,
        title: disabled ? t('expandDisabled') : t('expandAll'),
        onClick: () => setExpand((prev) => ({ seq: prev.seq + 1, mode: 'all' })),
      }, t('expandAll')),
      h('button', {
        key: 'none', type: 'button', className: 'jst-mini',
        onClick: () => setExpand((prev) => ({ seq: prev.seq + 1, mode: 'none' })),
      }, t('collapseAll')),
    ]),
    h('div', { key: 'body', className: 'jst-tree-body' }, h(TreeNode, {
      t,
      name: t('root'),
      value,
      path: '$',
      depth: 0,
      expandSeq: expand.seq,
      expandMode: expand.mode,
      onCopyPath: props.onCopyPath,
    })),
  ])
}

function TableView(props) {
  const t = props.t
  const value = props.value
  const model = React.useMemo(() => {
    if (!Array.isArray(value) || value.length === 0) return null
    if (value.length > MAX_TABLE_ROWS) return { tooMany: true }
    const columns = []
    for (const row of value) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
    }
    if (columns.length === 0 || columns.length > 40) return null
    return { columns, rows: value }
  }, [value])

  if (!model) return h('div', { className: 'jst-empty jst-empty-small' }, h('p', null, t('tableEmpty')))
  if (model.tooMany) return h('div', { className: 'jst-empty jst-empty-small' }, h('p', null, t('tableTooMany')))
  const shown = model.rows.slice(0, MAX_TABLE_ROWS)
  return h('div', { className: 'jst-table-wrap' }, h('table', { className: 'jst-table' }, [
    h('thead', { key: 'head' }, h('tr', null, [
      h('th', { key: '#', className: 'jst-th-index' }, '#'),
      ...model.columns.map((column) => h('th', { key: column }, column)),
    ])),
    h('tbody', { key: 'body' }, shown.map((row, index) => h('tr', { key: index }, [
      h('td', { key: '#', className: 'jst-td-index' }, index + 1),
      ...model.columns.map((column) => {
        const cell = row[column]
        const type = typeOf(cell)
        const text = cell === undefined
          ? '—'
          : type === 'object' || type === 'array'
            ? truncate(JSON.stringify(cell), 80)
            : String(cell)
        return h('td', {
          key: column,
          className: 'jst-td jst-td-' + type,
          title: type === 'string' ? cell : text,
        }, text)
      }),
    ]))),
  ]))
}

/* --------------------------------------------------------------------- panel */

function JsonStudioPanel(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const stored = React.useRef(undefined)
  if (stored.current === undefined) stored.current = readStore()
  const [input, setInput] = React.useState(() => (typeof stored.current.input === 'string' ? stored.current.input : ''))
  const [view, setView] = React.useState(() => (['code', 'tree', 'table'].includes(stored.current.view) ? stored.current.view : 'code'))
  const [wrap, setWrap] = React.useState(() => stored.current.wrap === true)
  const [ocrLangs, setOcrLangs] = React.useState(() => (typeof stored.current.ocrLangs === 'string' ? stored.current.ocrLangs : 'eng'))
  const [availableLangs, setAvailableLangs] = React.useState([])
  const [ocrBusy, setOcrBusy] = React.useState(false)
  const [ocrMeta, setOcrMeta] = React.useState(null)
  const [ocrError, setOcrError] = React.useState('')
  const [drop, setDrop] = React.useState(false)
  const [toast, setToast] = React.useState('')
  const [locateSeq, setLocateSeq] = React.useState(0)
  const [expand] = React.useState({ seq: 0 })
  const [shortcutLabel, setShortcutLabel] = React.useState(() => currentShortcut(DEFAULT_SHORTCUT))
  const themeMode = useThemeMode()
  const fileInput = React.useRef(null)
  const dragDepth = React.useRef(0)
  const toastTimer = React.useRef(null)
  const lastInput = React.useRef('')
  const textarea = React.useRef(null)
  const statusFetched = React.useRef(false)
  const inputRef = React.useRef(input)
  inputRef.current = input

  const deferred = useDebouncedValue(input, input.length > 40000 ? 320 : 130)
  const analysis = React.useMemo(() => {
    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    let result
    try {
      result = analyzeJson(deferred)
    } catch (error) {
      result = {
        ok: false, mode: 'fallback', value: undefined, formatted: prettyLoose(deferred),
        notes: [], error: { message: String(error && error.message ? error.message : error), offset: 0, line: 1, column: 1 },
        stats: { bytes: byteLength(deferred), chars: deferred.length, lines: deferred ? deferred.split('\n').length : 0, nodes: 0, depth: 0, keys: 0, arrays: 0, objects: 0 },
        candidates: [], truncated: false, ms: 0,
      }
    }
    result.ms = Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started)
    return result
  }, [deferred])
  const stale = deferred !== input

  React.useEffect(() => {
    const timer = setTimeout(() => writeStore({ input, view, wrap, ocrLangs }), 380)
    return () => clearTimeout(timer)
  }, [input, view, wrap, ocrLangs])

  React.useEffect(() => () => clearTimeout(toastTimer.current), [])

  React.useEffect(() => {
    if (statusFetched.current) return
    statusFetched.current = true
    let live = true
    fetch(STATUS_ENDPOINT, { credentials: 'same-origin' }).then((response) => response.json()).then((payload) => {
      if (!live || !payload || payload.ok !== true) return
      const langs = payload.ocr && Array.isArray(payload.ocr.langs) ? payload.ocr.langs : []
      setAvailableLangs(langs)
      if (typeof payload.shortcut === 'string' && payload.shortcut.trim() !== '' && !loadShortcutOverride()) {
        setShortcutLabel(payload.shortcut.trim())
      }
      if (langs.includes('chi_sim') && !stored.current.ocrLangs) setOcrLangs('eng+chi_sim')
    }).catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const flash = (message) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2400)
  }

  React.useEffect(() => {
    const onShortcut = (event) => {
      const next = event && event.detail && event.detail.shortcut ? event.detail.shortcut : DEFAULT_SHORTCUT
      setShortcutLabel(next)
    }
    window.addEventListener(SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(SHORTCUT_EVENT, onShortcut)
  }, [])

  // A shortcut may publish a selection before this panel mounts, or while it is
  // already open. Both paths end here: adopt the text, drop the pending draft,
  // and focus the editor at the end.
  React.useEffect(() => {
    const adopt = (text) => {
      if (typeof text !== 'string' || text.trim() === '') return
      clearPendingSelection()
      lastInput.current = inputRef.current
      setInput(text.slice(0, MAX_SELECTION_CHARS))
      setView('code')
      setOcrMeta(null)
      setOcrError('')
      flash(t('selectionLoaded'))
      requestAnimationFrame(() => {
        const element = textarea.current
        if (!element) return
        element.focus()
        try {
          element.setSelectionRange(element.value.length, element.value.length)
        } catch {
          /* ignore */
        }
      })
    }
    const pending = readPendingSelection()
    if (pending !== '') adopt(pending)
    const onInject = (event) => {
      if (event && event.detail && typeof event.detail.text === 'string') adopt(event.detail.text)
    }
    window.addEventListener(INJECT_EVENT, onInject)
    return () => window.removeEventListener(INJECT_EVENT, onInject)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = (text, done) => {
    copyText(text).then((ok) => flash(ok ? done : t('copyFailed')))
  }

  const applySample = (key) => {
    const text = SAMPLES[key] || SAMPLES.api
    lastInput.current = input
    setInput(text)
    setOcrMeta(null)
    setOcrError('')
    setView('code')
    if (textarea.current) textarea.current.focus()
  }

  const applyFormat = () => {
    if (!input.trim()) {
      flash(t('nothingToFormat'))
      return
    }
    lastInput.current = input
    setInput(analysis.formatted)
    setView('code')
    flash(t('formatApplied'))
  }

  const applyMinify = () => {
    if (!analysis.ok) {
      flash(t('cannotApply'))
      return
    }
    lastInput.current = input
    setInput(minifyValue(analysis.value))
    flash(t('minifyApplied'))
  }

  const applySort = () => {
    if (!analysis.ok) {
      flash(t('cannotApply'))
      return
    }
    lastInput.current = input
    setInput(formatValue(sortKeysDeep(analysis.value)))
    flash(t('sortedApplied'))
  }

  const applyEscape = () => {
    lastInput.current = input
    setInput(escapeJsonString(input))
    flash(t('escapedApplied'))
  }

  const applyUnescape = () => {
    const next = unescapeJsonString(input)
    if (next === input && !input.trim().startsWith('"')) {
      flash(t('notAString'))
      return
    }
    lastInput.current = input
    setInput(next)
    flash(t('unescapedApplied'))
  }

  const ingestImage = async (file) => {
    if (!file) return
    if (!/^image\//i.test(file.type || '')) {
      setOcrError(t('ocrNotImage'))
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setOcrError(t('ocrTooLarge'))
      return
    }
    setOcrBusy(true)
    setOcrError('')
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const response = await fetch(OCR_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, mime: file.type, langs: ocrLangs }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + response.status))
      const text = typeof payload.text === 'string' ? payload.text.replace(/\s+$/u, '') : ''
      if (text.trim().length === 0) {
        setOcrError(t('ocrEmpty'))
        return
      }
      lastInput.current = input
      setInput(text)
      setView('code')
      setOcrMeta({
        chars: text.length,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : null,
        ms: typeof payload.ms === 'number' ? payload.ms : null,
        langs: payload.langs || ocrLangs,
      })
    } catch (error) {
      setOcrError(t('ocrFailed') + ': ' + String(error && error.message ? error.message : error))
    } finally {
      setOcrBusy(false)
    }
  }

  const onDrop = (event) => {
    event.preventDefault()
    dragDepth.current = 0
    setDrop(false)
    const files = event.dataTransfer && event.dataTransfer.files
    if (files && files.length > 0) ingestImage(files[0])
  }

  const onDragEnter = (event) => {
    if (!event.dataTransfer) return
    const items = event.dataTransfer.items
    const hasFile = items ? Array.from(items).some((item) => item.kind === 'file') : true
    if (!hasFile) return
    event.preventDefault()
    dragDepth.current += 1
    setDrop(true)
  }

  const onDragLeave = (event) => {
    event.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDrop(false)
    }
  }

  const onPaste = (event) => {
    const items = event.clipboardData && event.clipboardData.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type && item.type.indexOf('image/') === 0) {
        event.preventDefault()
        ingestImage(item.getAsFile())
        return
      }
    }
  }

  const onKeyDown = (event) => {
    if (event.key === 'Tab') {
      event.preventDefault()
      const element = event.target
      const start = element.selectionStart
      const end = element.selectionEnd
      const next = input.slice(0, start) + '  ' + input.slice(end)
      setInput(next)
      requestAnimationFrame(() => {
        try {
          element.selectionStart = start + 2
          element.selectionEnd = start + 2
        } catch {
          /* noop */
        }
      })
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      applyFormat()
    }
  }

  const stats = analysis.stats || {}
  const errorLine = analysis.error && analysis.error.line ? analysis.error.line : 0
  const notes = analysis.notes || []
  const charCount = input.length
  const lineCount = input ? input.split('\n').length : 0
  const byteCount = byteLength(input)
  const mode = analysis.ok ? analysis.mode : 'fallback'
  const value = analysis.ok ? analysis.value : undefined
  const showEmpty = input.trim().length === 0

  const ocrOptions = []
  ocrOptions.push(['eng', t('ocrLangEn')])
  if (availableLangs.includes('chi_sim')) ocrOptions.push(['eng+chi_sim', t('ocrLangBoth')])
  const effectiveOcrLangs = ocrOptions.some(([value]) => value === ocrLangs) ? ocrLangs : 'eng'

  const toolbar = [
    ['format', applyFormat, true],
    ['minify', applyMinify],
    ['sortKeys', applySort],
    ['escape', applyEscape],
    ['unescape', applyUnescape],
  ]

  return h('div', {
    className: 'jst-root',
    'data-js-theme': themeMode,
    onDragEnter,
    onDragOver: (event) => event.preventDefault(),
    onDragLeave,
    onDrop,
  }, [
    h('header', { key: 'head', className: 'jst-head' }, [
      h('div', { key: 'brand', className: 'jst-brand' }, [
        h('span', { key: 'mark', className: 'jst-mark' }, h(IconBraces, { size: 18 })),
        h('div', { key: 'txt', className: 'jst-brand-text' }, [
          h('h1', { key: 'h', className: 'jst-title' }, t('panel')),
          h('span', { key: 's', className: 'jst-tagline' }, t('tagline')),
        ]),
      ]),
      h('div', { key: 'tools', className: 'jst-tools' }, [
        ...toolbar.map(([key, action, primary]) => h('button', {
          key,
          type: 'button',
          className: 'jst-btn' + (primary ? ' jst-btn-primary' : ''),
          onClick: action,
        }, primary ? h(IconWand, { size: 13 }) : null, h('span', null, t(key)))),
        h('span', { key: 'sep', className: 'jst-sep' }),
        h('button', { key: 'sample', type: 'button', className: 'jst-btn', onClick: () => {
          const keys = Object.keys(SAMPLES)
          const index = keys.indexOf(stored.current.lastSample)
          const next = keys[(index + 1) % keys.length]
          stored.current.lastSample = next
          applySample(next)
        } }, t('sample')),
        h('button', {
          key: 'image', type: 'button', className: 'jst-btn jst-btn-accent', disabled: ocrBusy,
          onClick: () => fileInput.current && fileInput.current.click(),
        }, h(IconImage, { size: 13 }), h('span', null, ocrBusy ? t('ocrReading') : t('imageOcr'))),
        h('button', {
          key: 'clear', type: 'button', className: 'jst-btn jst-btn-ghost', disabled: !input,
          onClick: () => {
            lastInput.current = input
            setInput('')
            setOcrMeta(null)
            setOcrError('')
            if (textarea.current) textarea.current.focus()
          },
        }, h(IconTrash, { size: 13 })),
        h('input', {
          key: 'file', ref: fileInput, type: 'file', accept: 'image/*', style: { display: 'none' },
          onChange: (event) => {
            const file = event.target.files && event.target.files[0]
            event.target.value = ''
            if (file) ingestImage(file)
          },
        }),
      ]),
    ]),

    ocrError !== '' ? h('div', { key: 'ocrerr', className: 'jst-banner jst-banner-error' }, [
      h(IconWarning, { key: 'i', size: 14 }),
      h('span', { key: 'm', className: 'jst-banner-text' }, ocrError),
      h('button', { key: 'x', type: 'button', className: 'jst-link', onClick: () => setOcrError('') }, '×'),
    ]) : null,

    ocrMeta ? h('div', { key: 'ocr', className: 'jst-banner jst-banner-ok' }, [
      h(IconImage, { key: 'i', size: 14 }),
      h('span', { key: 'm', className: 'jst-banner-text' }, [
        t('ocrFromImage') + ' · ' + numberLabel(ocrMeta.chars) + ' ' + t('chars'),
        ocrMeta.confidence !== null ? ' · ' + t('ocrConfidence') + ' ' + Math.round(ocrMeta.confidence) + '%' : '',
        ocrMeta.ms !== null ? ' · ' + ocrMeta.ms + ' ms' : '',
      ].join('')),
      h('button', {
        key: 'undo', type: 'button', className: 'jst-link',
        onClick: () => {
          setInput(lastInput.current)
          setOcrMeta(null)
        },
      }, t('ocrUndo')),
      h('button', { key: 'x', type: 'button', className: 'jst-link', onClick: () => setOcrMeta(null) }, '×'),
    ]) : null,

    h('div', { key: 'body', className: 'jst-body' }, [
      h('section', { key: 'in', className: 'jst-pane' }, [
        h('div', { key: 'h', className: 'jst-pane-head' }, [
          h('span', { key: 't', className: 'jst-pane-title' }, t('input')),
          h('span', { key: 'm', className: 'jst-pane-meta' }, numberLabel(charCount) + ' ' + t('chars') + ' · ' + numberLabel(lineCount) + ' ' + t('lines') + ' · ' + sizeLabel(byteCount)),
          ocrOptions.length > 1 ? h('select', {
            key: 'lang', className: 'jst-select', value: effectiveOcrLangs, title: t('ocrLang'),
            onChange: (event) => setOcrLangs(event.target.value),
          }, ocrOptions.map(([value, label]) => h('option', { key: value, value }, label))) : null,
        ]),
        h('textarea', {
          key: 'ta', ref: textarea, className: 'jst-input', value: input,
          spellCheck: false, wrap: 'off',
          placeholder: '{\n  "paste": "json, json5, python dict, ndjson…"\n}',
          onChange: (event) => setInput(event.target.value),
          onKeyDown, onPaste,
          'aria-label': t('input'),
        }),
        h('div', { key: 'hint', className: 'jst-pane-foot' }, t('inputHint') + ' · ' + shortcutLabel + ' ' + t('shortcutAction')),
      ]),
      h('section', { key: 'out', className: 'jst-pane jst-pane-output' }, [
        h('div', { key: 'h', className: 'jst-pane-head' }, [
          h('div', { key: 'tabs', className: 'jst-tabs' }, ['code', 'tree', 'table'].map((id) => h('button', {
            key: id,
            type: 'button',
            className: 'jst-tab' + (view === id ? ' jst-tab-active' : ''),
            onClick: () => setView(id),
          }, t('view' + id.charAt(0).toUpperCase() + id.slice(1))))),
          h('span', { key: 'badges', className: 'jst-pane-badges' }, [
            h(ModeBadge, { key: 'mode', t, mode }),
            stale ? h('span', { key: 'stale', className: 'jst-stale' }, '…') : null,
          ]),
          h('span', { key: 'spacer', className: 'jst-spacer' }),
          h('button', {
            key: 'wrap', type: 'button', className: 'jst-icon-btn' + (wrap ? ' jst-icon-active' : ''),
            title: t('wrap'), onClick: () => setWrap(!wrap),
          }, h(IconWrap, { size: 14 })),
          h('button', {
            key: 'copy', type: 'button', className: 'jst-icon-btn', title: t('copy'),
            onClick: () => copy(analysis.formatted || '', t('copied')),
          }, h(IconCopy, { size: 14 })),
          h('button', {
            key: 'dl', type: 'button', className: 'jst-icon-btn', title: t('download'),
            onClick: () => {
              if (!downloadText(analysis.formatted || '', 'json-studio-' + Date.now() + '.json')) flash(t('copyFailed'))
            },
          }, h(IconDownload, { size: 14 })),
        ]),

        !showEmpty && !analysis.ok ? h('div', { key: 'err', className: 'jst-error' }, [
          h(IconWarning, { key: 'i', size: 14 }),
          h('div', { key: 'body', className: 'jst-error-body' }, [
            h('strong', { key: 'h' }, t('parseError')),
            h('span', { key: 'm', className: 'jst-error-msg' }, [
              analysis.error && analysis.error.message ? analysis.error.message : '',
              analysis.error && analysis.error.line ? ' · ' + t('atLine') + ' ' + analysis.error.line + ' · ' + t('atColumn') + ' ' + analysis.error.column : '',
              ' · ' + t('notStrictHint'),
            ].join('')),
          ]),
          errorLine ? h('button', {
            key: 'locate', type: 'button', className: 'jst-link',
            onClick: () => setLocateSeq((value) => value + 1),
          }, t('locate')) : null,
        ]) : null,

        notes.length > 0 ? h('div', { key: 'notes', className: 'jst-note-row' }, [
          h('span', { key: 'label', className: 'jst-note-label' }, t('notes')),
          h(Notes, { key: 'list', t, notes }),
        ]) : null,

        h('div', { key: 'view', className: 'jst-view' }, showEmpty
          ? h(EmptyState, { t, onSample: applySample, shortcut: shortcutLabel })
          : view === 'tree'
            ? (analysis.ok
              ? h(TreeView, {
                t, value, nodes: stats.nodes || 0,
                onCopyPath: (path) => copy(path, t('pathCopied')),
              })
              : h('div', { className: 'jst-empty jst-empty-small' }, [
                h('p', { key: 'a' }, t('modeFallbackHint')),
                h('p', { key: 'b', className: 'jst-muted' }, t('cannotApply')),
              ]))
            : view === 'table'
              ? (analysis.ok
                ? h(TableView, { t, value })
                : h('div', { className: 'jst-empty jst-empty-small' }, h('p', null, t('modeFallbackHint'))))
              : h(CodeView, {
                t, text: analysis.formatted || '', wrap, errorLine, locateSeq,
              })),
      ]),
    ]),

    h('footer', { key: 'foot', className: 'jst-foot' }, [
      h('span', { key: 'mode', className: 'jst-foot-item' }, h(ModeBadge, { t, mode })),
      analysis.ok ? h('span', { key: 'stats', className: 'jst-foot-item' }, [
        numberLabel(stats.nodes || 0) + ' ' + t('nodes'),
        ' · ' + numberLabel(stats.depth || 0) + ' ' + t('depth'),
        ' · ' + numberLabel(stats.keys || 0) + ' ' + t('keys'),
      ].join('')) : null,
      analysis.truncated ? h('span', { key: 'trunc', className: 'jst-foot-item jst-foot-warn' }, notes.some((note) => note.code === 'input-too-large') ? t('noteInputTooLarge') : t('noteTruncatedInput')) : null,
      h('span', { key: 'spacer', className: 'jst-spacer' }),
      h('span', { key: 'ms', className: 'jst-foot-item' }, (analysis.ms || 0).toFixed(1) + ' ms'),
    ]),

    drop ? h('div', { key: 'drop', className: 'jst-drop' }, [
      h('div', { key: 'card', className: 'jst-drop-card' }, [
        h(IconImage, { key: 'i', size: 30 }),
        h('strong', { key: 't' }, t('dropTitle')),
        h('span', { key: 'b', className: 'jst-muted' }, t('dropBody')),
      ]),
    ]) : null,

    toast !== '' ? h('div', { key: 'toast', className: 'jst-toast' }, toast) : null,
  ])
}

/* --------------------------------------------------------------------- apply */

const inject = ['slots', 'locale', 'layout']

const PANEL_CSS = `
.jst-root{--jst-bg:var(--dsw-alias-bg-base,#ffffff);--jst-layer:var(--dsw-alias-bg-layer-2,#f5f6f8);--jst-overlay:var(--dsw-alias-bg-overlay,#ffffff);--jst-border:var(--dsw-alias-border-l1,#e5e7eb);--jst-border-strong:var(--dsw-alias-border-l2,#d4d8de);--jst-text:var(--dsw-alias-label-primary,#1f2329);--jst-muted:var(--dsw-alias-label-secondary,#6b7280);--jst-brand:var(--dsw-alias-brand-primary,#3b82f6);--jst-ok:var(--dsw-alias-state-success-primary,#16a34a);--jst-warn:var(--dsw-alias-state-warn-primary,#d97706);--jst-err:var(--dsw-alias-state-error-primary,#dc2626);position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--jst-bg);color:var(--jst-text);font-size:13px;line-height:1.5}
.jst-root *{box-sizing:border-box}
.jst-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--jst-border);background:linear-gradient(180deg,var(--jst-layer),transparent)}
.jst-brand{display:flex;align-items:center;gap:10px;min-width:0}
.jst-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;color:#fff;background:linear-gradient(135deg,#6366f1,#0ea5e9);box-shadow:0 2px 8px rgba(59,130,246,.28)}
.jst-brand-text{display:flex;flex-direction:column;min-width:0}
.jst-title{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px}
.jst-tagline{font-size:11px;color:var(--jst-muted);white-space:nowrap}
.jst-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.jst-sep{width:1px;height:18px;background:var(--jst-border-strong);margin:0 2px}
.jst-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--jst-border-strong);background:var(--jst-overlay);color:var(--jst-text);border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,transform .12s}
.jst-btn:hover:not(:disabled){background:var(--jst-layer);border-color:var(--jst-brand)}
.jst-btn:active:not(:disabled){transform:translateY(1px)}
.jst-btn:disabled{opacity:.45;cursor:default}
.jst-btn-primary{background:linear-gradient(180deg,#4f8df9,#3b82f6);border-color:transparent;color:#fff;font-weight:600}
.jst-btn-primary:hover:not(:disabled){background:linear-gradient(180deg,#5b96fb,#2f74e8);border-color:transparent}
.jst-btn-accent{border-color:color-mix(in srgb,var(--jst-brand) 55%,transparent);color:var(--jst-brand)}
.jst-btn-ghost{padding:5px 7px}
.jst-banner{display:flex;align-items:center;gap:8px;padding:7px 18px;font-size:12px;border-bottom:1px solid var(--jst-border)}
.jst-banner-ok{background:color-mix(in srgb,var(--jst-ok) 10%,transparent);color:var(--jst-ok)}
.jst-banner-error{background:color-mix(in srgb,var(--jst-err) 10%,transparent);color:var(--jst-err)}
.jst-banner-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jst-link{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px;text-decoration:underline;text-underline-offset:2px}
.jst-link:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.jst-body{display:flex;flex:1;min-height:0;gap:12px;padding:12px}
.jst-pane{display:flex;flex:1 1 0;flex-direction:column;min-width:0;min-height:0;border:1px solid var(--jst-border);border-radius:12px;background:var(--jst-layer);overflow:hidden}
.jst-pane-output{background:var(--jst-bg)}
.jst-pane-head{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--jst-border);min-height:38px}
.jst-pane-title{font-size:12px;font-weight:600;color:var(--jst-muted);text-transform:uppercase;letter-spacing:.5px}
.jst-pane-meta{margin-left:auto;font-size:11px;color:var(--jst-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jst-select{border:1px solid var(--jst-border-strong);background:var(--jst-overlay);color:var(--jst-text);border-radius:6px;font:inherit;font-size:11px;padding:2px 4px;max-width:120px}
.jst-input{flex:1;min-height:0;width:100%;border:0;outline:none;resize:none;background:transparent;color:var(--jst-text);padding:10px 13px;font:12.5px/1.65 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;tab-size:2}
.jst-input::placeholder{color:var(--jst-muted);opacity:.75}
.jst-pane-foot{padding:5px 12px;border-top:1px dashed var(--jst-border);font-size:10.5px;color:var(--jst-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jst-tabs{display:flex;gap:2px;background:var(--jst-layer);border:1px solid var(--jst-border);border-radius:8px;padding:2px}
.jst-tab{border:0;background:transparent;color:var(--jst-muted);font:inherit;font-size:11.5px;padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.jst-tab:hover{color:var(--jst-text)}
.jst-tab-active{background:var(--jst-overlay);color:var(--jst-text);box-shadow:0 1px 3px rgba(0,0,0,.10);font-weight:600}
.jst-pane-badges{display:flex;align-items:center;gap:6px}
.jst-stale{color:var(--jst-muted);font-size:11px}
.jst-spacer{flex:1}
.jst-icon-btn{display:grid;place-items:center;width:26px;height:26px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--jst-muted);cursor:pointer}
.jst-icon-btn:hover{background:var(--jst-layer);color:var(--jst-text);border-color:var(--jst-border)}
.jst-icon-active{color:var(--jst-brand);border-color:color-mix(in srgb,var(--jst-brand) 40%,transparent);background:color-mix(in srgb,var(--jst-brand) 8%,transparent)}
.jst-mode{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;border-radius:999px;padding:2px 8px;border:1px solid transparent;white-space:nowrap}
.jst-dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 18%,transparent)}
.jst-mode-strict{color:var(--jst-ok);background:color-mix(in srgb,var(--jst-ok) 10%,transparent);border-color:color-mix(in srgb,var(--jst-ok) 30%,transparent)}
.jst-mode-relaxed{color:var(--jst-brand);background:color-mix(in srgb,var(--jst-brand) 10%,transparent);border-color:color-mix(in srgb,var(--jst-brand) 28%,transparent)}
.jst-mode-repaired{color:var(--jst-warn);background:color-mix(in srgb,var(--jst-warn) 12%,transparent);border-color:color-mix(in srgb,var(--jst-warn) 32%,transparent)}
.jst-mode-fallback{color:var(--jst-err);background:color-mix(in srgb,var(--jst-err) 10%,transparent);border-color:color-mix(in srgb,var(--jst-err) 30%,transparent)}
.jst-error{display:flex;align-items:flex-start;gap:8px;margin:8px 10px 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--jst-err) 38%,transparent);background:color-mix(in srgb,var(--jst-err) 8%,transparent);color:var(--jst-err);border-radius:9px;font-size:12px}
.jst-error-body{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.jst-error-msg{color:var(--jst-muted);font-size:11.5px;word-break:break-word}
.jst-note-row{display:flex;align-items:flex-start;gap:8px;padding:6px 12px 0;min-width:0}
.jst-note-label{flex:none;font-size:10.5px;color:var(--jst-muted);padding-top:2px}
.jst-notes{display:flex;gap:5px;flex-wrap:wrap;min-width:0;overflow:hidden;max-height:44px}
.jst-note{font-size:10.5px;color:var(--jst-muted);background:var(--jst-layer);border:1px solid var(--jst-border);border-radius:999px;padding:1px 8px;white-space:nowrap}
.jst-view{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.jst-code-wrap{flex:1;min-height:0;overflow:auto;padding:6px 0}
.jst-code{margin:0;padding:0 0 10px;font:12.5px/1.6 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;tab-size:2;color:var(--jst-text)}
.jst-line{display:flex;min-width:max-content}
.jst-line:hover{background:color-mix(in srgb,var(--jst-brand) 5%,transparent)}
.jst-line-error{background:color-mix(in srgb,var(--jst-err) 12%,transparent)!important;box-shadow:inset 2px 0 0 var(--jst-err)}
.jst-ln{flex:none;width:46px;padding:0 10px 0 6px;text-align:right;color:var(--jst-muted);opacity:.65;user-select:none;font-size:11px;line-height:1.82}
.jst-line-body{flex:1;white-space:pre;min-width:0;padding-right:16px}
.jst-wrap .jst-line{min-width:0}
.jst-wrap .jst-line-body{white-space:pre-wrap;word-break:break-word}
.jst-tok{white-space:inherit}
.jst-tok-key{color:#7c3aed;font-weight:500}
.jst-tok-string{color:#15803d}
.jst-tok-number{color:#b45309}
.jst-tok-literal{color:#1d4ed8;font-weight:500}
.jst-tok-punct{color:var(--jst-muted)}
.jst-tok-comment{color:#94a3b8;font-style:italic}
.jst-tok-bare{color:var(--jst-text)}
.jst-tok-invalid{color:var(--jst-err);text-decoration:underline wavy}
.jst-tok-plain{color:var(--jst-text)}
[data-js-theme="dark"] .jst-tok-key{color:#c4b5fd}
[data-js-theme="dark"] .jst-tok-string{color:#86efac}
[data-js-theme="dark"] .jst-tok-number{color:#fbbf24}
[data-js-theme="dark"] .jst-tok-literal{color:#93c5fd}
[data-js-theme="dark"] .jst-tok-comment{color:#64748b}
.jst-view-note{padding:6px 14px;font-size:11px;color:var(--jst-muted);border-top:1px dashed var(--jst-border);background:var(--jst-layer)}
.jst-tree{flex:1;min-height:0;display:flex;flex-direction:column}
.jst-tree-bar{display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--jst-border)}
.jst-mini{border:1px solid var(--jst-border);background:var(--jst-overlay);color:var(--jst-muted);border-radius:6px;font:inherit;font-size:11px;padding:2px 8px;cursor:pointer}
.jst-mini:hover:not(:disabled){color:var(--jst-text);border-color:var(--jst-border-strong)}
.jst-mini:disabled{opacity:.45;cursor:default}
.jst-tree-body{flex:1;min-height:0;overflow:auto;padding:6px 0 14px}
.jst-node{display:flex;align-items:center;gap:6px;padding:1px 10px 1px 8px;min-height:24px;font-size:12.5px}
.jst-node:hover{background:color-mix(in srgb,var(--jst-brand) 6%,transparent)}
.jst-node-container{font-weight:500}
.jst-chev{display:grid;place-items:center;width:16px;height:16px;flex:none;border:0;background:transparent;color:var(--jst-muted);cursor:pointer;padding:0;border-radius:4px}
.jst-chev:hover{background:var(--jst-layer);color:var(--jst-text)}
.jst-chev-empty{pointer-events:none}
.jst-node-name{color:var(--jst-text);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jst-colon{color:var(--jst-muted);flex:none;margin-left:-3px}
.jst-type{font-size:10.5px;color:var(--jst-muted);background:var(--jst-layer);border:1px solid var(--jst-border);border-radius:5px;padding:0 6px;white-space:nowrap}
.jst-type-array{color:#0e7490;border-color:color-mix(in srgb,#0e7490 25%,transparent)}
.jst-type-object{color:#7c3aed;border-color:color-mix(in srgb,#7c3aed 25%,transparent)}
[data-js-theme="dark"] .jst-type-array{color:#67e8f9}
[data-js-theme="dark"] .jst-type-object{color:#c4b5fd}
.jst-val{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.jst-val-string{color:#15803d}
.jst-val-number{color:#b45309}
.jst-val-boolean{color:#1d4ed8}
.jst-val-null{color:var(--jst-muted);font-style:italic}
[data-js-theme="dark"] .jst-val-string{color:#86efac}
[data-js-theme="dark"] .jst-val-number{color:#fbbf24}
[data-js-theme="dark"] .jst-val-boolean{color:#93c5fd}
.jst-path{margin-left:auto;display:grid;place-items:center;width:20px;height:20px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--jst-muted);cursor:pointer;opacity:0}
.jst-node:hover .jst-path{opacity:1}
.jst-path:hover{background:var(--jst-layer);border-color:var(--jst-border);color:var(--jst-text)}
.jst-children{display:block}
.jst-table-wrap{flex:1;min-height:0;overflow:auto}
.jst-table{border-collapse:separate;border-spacing:0;width:100%;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}
.jst-table th{position:sticky;top:0;z-index:1;text-align:left;background:var(--jst-layer);color:var(--jst-muted);font-weight:600;font-size:11px;padding:6px 10px;border-bottom:1px solid var(--jst-border-strong);white-space:nowrap}
.jst-table td{padding:4px 10px;border-bottom:1px solid var(--jst-border);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jst-table tbody tr:hover{background:color-mix(in srgb,var(--jst-brand) 6%,transparent)}
.jst-th-index,.jst-td-index{width:44px;text-align:right;color:var(--jst-muted);font-size:11px}
.jst-td-null{color:var(--jst-muted);font-style:italic}
.jst-td-boolean{color:#1d4ed8}
.jst-td-number{color:#b45309;text-align:right}
[data-js-theme="dark"] .jst-td-boolean{color:#93c5fd}
[data-js-theme="dark"] .jst-td-number{color:#fbbf24}
.jst-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px;text-align:center}
.jst-empty-small{justify-content:flex-start;padding:22px;color:var(--jst-muted)}
.jst-empty-mark{display:grid;place-items:center;width:58px;height:58px;border-radius:18px;color:var(--jst-brand);background:color-mix(in srgb,var(--jst-brand) 10%,transparent);border:1px solid color-mix(in srgb,var(--jst-brand) 24%,transparent)}
.jst-empty-title{margin:0;font-size:16px;font-weight:650}
.jst-empty-body{margin:0;max-width:520px;color:var(--jst-muted);font-size:12px;line-height:1.7}
.jst-empty-hint{margin:0;color:var(--jst-muted);font-size:11px;opacity:.85}
.jst-chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin:2px 0}
.jst-chip{border:1px solid var(--jst-border-strong);background:var(--jst-overlay);color:var(--jst-text);border-radius:999px;padding:4px 12px;font:inherit;font-size:11.5px;cursor:pointer}
.jst-chip:hover{border-color:var(--jst-brand);color:var(--jst-brand)}
.jst-drop{position:absolute;inset:0;z-index:20;display:grid;place-items:center;background:color-mix(in srgb,var(--jst-bg) 72%,transparent);backdrop-filter:blur(2px);border:2px dashed var(--jst-brand);border-radius:12px;margin:6px}
.jst-drop-card{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 34px;border-radius:16px;background:var(--jst-overlay);border:1px solid var(--jst-border-strong);box-shadow:0 18px 50px rgba(0,0,0,.22);color:var(--jst-text)}
.jst-drop-card svg{color:var(--jst-brand)}
.jst-toast{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);z-index:30;background:rgba(24,28,36,.94);color:#fff;border-radius:999px;padding:7px 16px;font-size:12px;box-shadow:0 8px 28px rgba(0,0,0,.28);max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jst-foot{display:flex;align-items:center;gap:12px;padding:5px 16px;border-top:1px solid var(--jst-border);font-size:11px;color:var(--jst-muted);min-height:30px;background:var(--jst-layer)}
.jst-foot-item{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jst-foot-warn{color:var(--jst-warn)}
.jst-muted{color:var(--jst-muted)}
.jst-set-root{overflow:auto;padding:26px 30px;display:flex;flex-direction:column;gap:18px}
.jst-set-head{display:flex;align-items:center;gap:10px}
.jst-set-heading{display:flex;flex-direction:column}
.jst-set-title{margin:0;font-size:16px;font-weight:650}
.jst-set-sub{margin:0;color:var(--jst-muted);font-size:12px}
.jst-set-card{display:flex;flex-direction:column;gap:10px;max-width:920px;padding:16px 18px;border:1px solid var(--jst-border);border-radius:12px;background:var(--jst-layer)}
.jst-set-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}
.jst-set-copy{display:flex;flex-direction:column;gap:4px;flex:1;min-width:260px;padding-right:12px}
.jst-set-label{font-size:13px;font-weight:600}
.jst-set-desc{margin:0;font-size:12px;line-height:1.6;color:var(--jst-muted)}
.jst-set-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.jst-kbd{font:12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--jst-text);background:var(--jst-overlay);border:1px solid var(--jst-border-strong);border-bottom-width:2px;border-radius:7px;padding:6px 10px;white-space:nowrap}
.jst-set-hint{margin:0;font-size:11.5px;color:var(--jst-muted)}
.jst-set-error{margin:0;font-size:12px;color:var(--jst-err)}
.jst-set-saved{margin:0;font-size:12px;color:var(--jst-ok)}
.jst-root *{scrollbar-width:thin;scrollbar-color:var(--jst-border-strong) transparent}
.jst-root *::-webkit-scrollbar{width:10px;height:10px}
.jst-root *::-webkit-scrollbar-track{background:transparent}
.jst-root *::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--jst-muted) 42%,transparent);border-radius:999px;border:2px solid transparent;background-clip:content-box}
.jst-root *::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--jst-muted) 65%,transparent);background-clip:content-box}
.jst-root *::-webkit-scrollbar-corner{background:transparent}
@media (max-width:980px){.jst-body{flex-direction:column}.jst-pane{flex:1 1 45%}.jst-tools{width:100%;margin-left:0}.jst-head{gap:10px}.jst-brand-text{display:none}}
`

function apply(ctx) {
  const t = ctx.locale.bind(NS)
  let shortcut = DEFAULT_SHORTCUT
  fetch(STATUS_ENDPOINT, { credentials: 'same-origin' }).then((response) => response.json()).then((payload) => {
    if (payload && typeof payload.shortcut === 'string' && payload.shortcut.trim() !== '') {
      shortcut = payload.shortcut.trim()
    }
  }).catch(() => {})

  // In-app global shortcut: works wherever the focus is, including the composer.
  // A non-empty selection is carried into the panel; without one the panel just
  // opens on its current draft.
  ctx.effect(() => {
    const onKeyDown = (event) => {
      if (shortcutRecording) return
      if (event.repeat || !matchesShortcut(event, currentShortcut(shortcut))) return
      const selected = readSelectedText().slice(0, MAX_SELECTION_CHARS)
      event.preventDefault()
      if (selected.trim() === '') {
        try {
          if (ctx.layout) ctx.layout.selectPanel(PANEL_ID)
        } catch {
          /* not registered yet */
        }
        return
      }
      publishSelection(ctx, selected)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, 'json-studio: shortcut')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, JsonStudioPanel)), 'json-studio: page')

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PANEL_ID,
    order: 35,
    label: () => t('settingsHeading'),
  }, (props) => h(JsonStudioSettings, { ...props, t }))), 'json-studio: settings section')

  ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: PANEL_ID,
    order: 35,
  }, SidebarIcon)), 'json-studio: settings icon')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 55,
    label: () => t('panel'),
    locale: NS,
  }, SidebarIcon)), 'json-studio: sidebar entry')

  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'json-studio: dictionaries')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = PANEL_ID
    style.dataset.pluginCss = PANEL_ID + '/panel.css'
    style.textContent = PANEL_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'json-studio: styles')
}

return { inject, apply }
