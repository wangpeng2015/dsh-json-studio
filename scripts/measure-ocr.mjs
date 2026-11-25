/**
 * Measure OCR accuracy/time for json-studio fixtures and tune PSM/lang settings.
 *
 * Run from E:\selfwork\json-studio:
 *   node scripts/measure-ocr.mjs
 *
 * The script intentionally talks to tesseract.js directly so it can sweep
 * page-segmentation modes and `preserve_interword_spaces`, then re-runs the
 * committed `src/ocr.js` engine so the reported numbers are the real ones.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWorker, OEM } from 'tesseract.js';
import { createOcrEngine } from '../src/ocr.js';

const resolveUrl = (url) => fileURLToPath(url);
const LANG_DIR = resolveUrl(new URL('../assets/lang/', import.meta.url));
const CACHE_DIR = `${process.env.TEMP || process.env.TMP || '.'}/json-studio-ocr-bench-cache`;
const FIXTURES = resolveUrl(new URL('../test/fixtures/ocr/', import.meta.url));

const CLEAN = `{
  "name": "json-studio",
  "version": "1.0.0",
  "active": true,
  "list": [1, 2, 3],
  "tags": ["ocr", "json"],
  "meta": { "author": "lead" }
}`;

const IDE = `{
  "id": 1024,
  "name": "json-studio",
  "kind": "panel",
  "enabled": true,
  "items": [
    { "key": "alpha", "value": 1 },
    { "key": "beta", "value": 2 }
  ],
  "meta": {
    "author": "lead",
    "version": "1.0.0",
    "list": ["ocr", "json", "ui"]
  }
}`;

const CHINESE = `{
  "标题": "数据报告",
  "状态": "成功",
  "说明": "这是一份 JSON 测试",
  "数量": 42,
  "list": [1, 2, 3]
}`;

const CASES = [
  {
    file: 'json-clean-900x420.png',
    name: 'clean 900x420',
    langs: 'eng',
    truth: CLEAN,
    keys: ['name', 'json-studio', 'version', '1.0.0', 'active', 'true', 'list', 'tags', 'ocr', 'meta', 'author', 'lead'],
    stripLineNumbers: false,
  },
  {
    file: 'json-ide-1920x1080.png',
    name: 'IDE 1920x1080',
    langs: 'eng',
    truth: IDE,
    keys: ['id', '1024', 'name', 'json-studio', 'kind', 'panel', 'enabled', 'true', 'items', 'key', 'alpha', 'beta', 'meta', 'author', 'lead', 'list', 'ui'],
    stripLineNumbers: true,
  },
  {
    file: 'json-chinese.png',
    name: 'Chinese+JSON',
    langs: 'chi_sim+eng',
    truth: CHINESE,
    keys: ['标题', '数据报告', '状态', '成功', '说明', 'JSON', '测试', '数量', '42', 'list'],
    stripLineNumbers: false,
  },
  {
    file: 'json-lowres-600w.png',
    name: 'lowres 600w',
    langs: 'eng',
    truth: CLEAN,
    keys: ['name', 'json-studio', 'version', '1.0.0', 'active', 'true', 'list', 'tags', 'ocr', 'meta', 'author', 'lead'],
    stripLineNumbers: false,
  },
];

function collapse(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function stripNumbers(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d{1,3}\s+/, ''))
    .join('\n');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function cer(truth, text) {
  const t = collapse(truth);
  const o = collapse(text);
  if (!t.length) return 0;
  return Math.round((levenshtein(t, o) / t.length) * 1000) / 10;
}

function lineRecall(truth, text) {
  const truthLines = truth.split('\n').map(collapse).filter(Boolean);
  const got = text.split('\n').map(collapse).filter(Boolean);
  const haystack = `\n${got.join('\n')}\n`;
  const found = truthLines.filter((line) => haystack.includes(line)).length;
  return { found, total: truthLines.length, pct: Math.round((found / truthLines.length) * 100) };
}

function keyRecall(keys, text) {
  const got = text.toLowerCase();
  const found = keys.filter((key) => got.includes(key.toLowerCase())).length;
  return { found, total: keys.length, pct: Math.round((found / keys.length) * 100) };
}

function normalizeForCase(caseDef, text) {
  return caseDef.stripLineNumbers ? stripNumbers(text) : text;
}

async function measureRaw({ caseDef, base64, pagesegMode, preserve, langOverride }) {
  const langs = langOverride || caseDef.langs;
  const worker = await createWorker(langs, OEM.LSTM_ONLY, {
    langPath: LANG_DIR,
    gzip: true,
    cachePath: CACHE_DIR,
    logger: () => {},
    errorHandler: () => {},
  });
  await worker.setParameters({
    tessedit_pageseg_mode: pagesegMode,
    preserve_interword_spaces: preserve,
  });
  const buffer = Buffer.from(base64, 'base64');
  // Warm-up (model/API is already initialized; this measures steady state).
  await worker.recognize(buffer, {}, { text: true });
  const started = Date.now();
  const { data } = await worker.recognize(buffer, {}, { text: true });
  const ms = Date.now() - started;
  await worker.terminate();
  const text = normalizeForCase(caseDef, data.text || '');
  return {
    text,
    confidence: Math.round(Number(data.confidence) * 10) / 10,
    ms,
    cer: cer(caseDef.truth, text),
    lines: lineRecall(caseDef.truth, text),
    keys: keyRecall(caseDef.keys, text),
  };
}

function row(label, result) {
  return {
    config: label,
    conf: result.confidence,
    ms: result.ms,
    cer: result.cer,
    line: `${result.lines.found}/${result.lines.total} (${result.lines.pct}%)`,
    keys: `${result.keys.found}/${result.keys.total} (${result.keys.pct}%)`,
  };
}

async function main() {
  const fixtures = {};
  for (const caseDef of CASES) {
    fixtures[caseDef.file] = await readFile(FIXTURES + caseDef.file);
  }

  const sweep = [
    { psm: '6', preserve: '1' },
    { psm: '6', preserve: '0' },
    { psm: '4', preserve: '0' },
    { psm: '3', preserve: '0' },
    { psm: '11', preserve: '0' },
    { psm: '12', preserve: '0' },
  ];

  for (const caseDef of CASES) {
    console.log(`\n### ${caseDef.name} (${caseDef.file}) langs=${caseDef.langs}`);
    console.log('| PSM | preserve | conf | ms | CER% | lines | keys |');
    console.log('| --- | -------- | ---- | -- | ---- | ----- | ---- |');
    for (const config of sweep) {
      try {
        const result = await measureRaw({
          caseDef,
          base64: fixtures[caseDef.file].toString('base64'),
          pagesegMode: config.psm,
          preserve: config.preserve,
        });
        const r = row(`PSM ${config.psm}`, result);
        console.log(`| ${config.psm} | ${config.preserve} | ${r.conf} | ${r.ms} | ${r.cer} | ${r.line} | ${r.keys} |`);
      } catch (error) {
        console.log(`| ${config.psm} | ${config.preserve} | failed: ${error.message || error} | | | | |`);
      }
    }
  }

  // Language comparison on the Chinese fixture.
  console.log('\n### Chinese fixture: language choice (PSM 6, preserve 1)');
  console.log('| langs | conf | ms | CER% | lines | keys |');
  console.log('| ----- | ---- | -- | ---- | ----- | ---- |');
  const chineseCase = CASES.find((c) => c.file === 'json-chinese.png');
  for (const langs of ['eng', 'chi_sim', 'chi_sim+eng']) {
    const result = await measureRaw({
      caseDef: chineseCase,
      base64: fixtures['json-chinese.png'].toString('base64'),
      pagesegMode: '6',
      preserve: '1',
      langOverride: langs,
    });
    console.log(`| ${langs} | ${result.confidence} | ${result.ms} | ${result.cer} | ${result.lines.found}/${result.lines.total} (${result.lines.pct}%) | ${result.keys.found}/${result.keys.total} (${result.keys.pct}%) |`);
  }

  // Final numbers through the committed engine (cold + warm).
  console.log('\n### Committed createOcrEngine() (PSM 6, preserve 1), cold then warm');
  console.log('| fixture | run | conf | ms | CER% | lines | keys |');
  console.log('| ------- | --- | ---- | -- | ---- | ----- | ---- |');
  const engine = createOcrEngine({ langDir: LANG_DIR, logger: () => {} });
  for (const caseDef of CASES) {
    const base64 = fixtures[caseDef.file].toString('base64');
    for (const run of ['cold', 'warm']) {
      const result = await engine.recognize({ base64, langs: caseDef.langs });
      const text = normalizeForCase(caseDef, result.text);
      const lines = lineRecall(caseDef.truth, text);
      const keys = keyRecall(caseDef.keys, text);
      console.log(`| ${caseDef.file} | ${run} | ${result.confidence} | ${result.ms} | ${cer(caseDef.truth, text)} | ${lines.found}/${lines.total} (${lines.pct}%) | ${keys.found}/${keys.total} (${keys.pct}%) |`);
    }
  }
  await engine.dispose();
  console.log('\nDone.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
