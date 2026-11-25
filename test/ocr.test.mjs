/**
 * OCR engine tests for JSON Studio.
 *
 * Run from E:\selfwork\json-studio:
 *   node --test test/ocr.test.mjs
 *
 * The fixtures are committed PNGs under `test/fixtures/ocr/` (regenerate with
 * `scripts/make-ocr-fixtures.py`). Language data is vendored under
 * `assets/lang/`; when it is missing the recognition tests are skipped instead
 * of failing.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOcrEngine } from '../src/ocr.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LANG_DIR = join(ROOT, 'assets', 'lang');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'ocr');

const hasEng = existsSync(join(LANG_DIR, 'eng.traineddata.gz'));
const hasChinese = existsSync(join(LANG_DIR, 'chi_sim.traineddata.gz'));
const missingLangReason = 'traineddata missing from assets/lang; skipping OCR recognition tests';

const engine = createOcrEngine({
  langDir: LANG_DIR,
  defaultLangs: 'eng',
  logger: () => {},
});

async function fixtureBase64(name) {
  return (await readFile(join(FIXTURES, name))).toString('base64');
}

function nonEmptyLines(text) {
  return text.split('\n').filter((line) => line.trim() !== '');
}

before(() => {
  assert.ok(existsSync(FIXTURES), 'fixtures directory must exist');
});

after(async () => {
  await engine.dispose();
});

test('describe() reports engine state without creating a worker', () => {
  const info = engine.describe();
  assert.equal(info.engine, 'tesseract.js');
  assert.equal(info.ready, false);
  assert.ok(Array.isArray(info.langs));
  assert.ok(Array.isArray(info.langFiles));
  if (hasEng) {
    assert.ok(info.langFiles.includes('eng.traineddata.gz'), 'eng traineddata should be vendored');
  }
  if (hasChinese) {
    assert.ok(info.langFiles.includes('chi_sim.traineddata.gz'), 'chi_sim traineddata should be vendored');
  }
});

test('clean 900x420 JSON screenshot (data URL input)', { skip: !hasEng && missingLangReason }, async () => {
  const base64 = await fixtureBase64('json-clean-900x420.png');
  const result = await engine.recognize({
    base64: `data:image/png;base64,${base64}`,
    mime: 'image/png',
  });

  assert.equal(result.langs, 'eng');
  assert.ok(result.ms > 0, 'ms must be positive');
  assert.ok(result.confidence > 50, `confidence ${result.confidence} should exceed 50`);
  assert.equal(result.width, 900);
  assert.equal(result.height, 420);

  assert.match(result.text, /name/i);
  assert.match(result.text, /json-studio/i);
  assert.match(result.text, /version/i);
  assert.match(result.text, /1\.0\.0/);
  assert.match(result.text, /active/i);
  assert.match(result.text, /true/i);
  assert.match(result.text, /"list"/i);
  assert.match(result.text, /"tags"/i);
  assert.match(result.text, /"ocr"/i);
  assert.match(result.text, /"json"/i);
  assert.match(result.text, /"meta"/i);
  assert.match(result.text, /"author"/i);
  assert.match(result.text, /"lead"/i);

  assert.ok(nonEmptyLines(result.text).length >= 5, 'should recognize the whole block');
  assert.ok(!result.text.includes('\r'), 'text should use \\n line endings');
  assert.equal(result.text, result.text.replace(/[ \t]+$/gm, ''), 'no trailing whitespace');
  assert.equal(result.text, result.text.replace(/\n+$/, ''), 'no trailing blank lines');
});

test('describe() reports ready once the worker exists', { skip: !hasEng && missingLangReason }, () => {
  const info = engine.describe();
  assert.equal(info.ready, true);
  assert.equal(info.engine, 'tesseract.js');
});

test('1920x1080 dark IDE screenshot with line numbers', { skip: !hasEng && missingLangReason }, async () => {
  const base64 = await fixtureBase64('json-ide-1920x1080.png');
  const result = await engine.recognize({ base64 }); // bare base64, no mime

  assert.equal(result.langs, 'eng');
  assert.ok(result.ms > 0);
  assert.ok(result.confidence > 50, `confidence ${result.confidence} should exceed 50`);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);

  for (const expected of ['id', '1024', 'name', 'json-studio', 'kind', 'panel', 'items', 'key', 'alpha', 'beta', 'meta', 'author']) {
    assert.match(result.text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `expected "${expected}" in OCR text`);
  }
  assert.ok(nonEmptyLines(result.text).length >= 10, 'IDE screenshot should produce many lines');
});

test('600px-wide low-resolution screenshot', { skip: !hasEng && missingLangReason }, async () => {
  const base64 = await fixtureBase64('json-lowres-600w.png');
  const result = await engine.recognize({ base64, mime: 'png' });

  assert.ok(result.ms > 0);
  assert.ok(result.confidence > 50, `confidence ${result.confidence} should exceed 50`);
  assert.equal(result.width, 600);

  for (const expected of ['name', 'json-studio', 'version', 'active', 'true', 'list', 'tags']) {
    assert.match(result.text, new RegExp(expected, 'i'), `expected "${expected}" in low-res OCR text`);
  }
});

test('Chinese + JSON screenshot recognizes both scripts', { skip: !hasChinese && 'chi_sim traineddata missing from assets/lang' }, async () => {
  const base64 = await fixtureBase64('json-chinese.png');
  const result = await engine.recognize({ base64, mime: 'image/png', langs: 'chi_sim+eng' });

  assert.equal(result.langs, 'chi_sim+eng');
  assert.ok(result.ms > 0);
  assert.ok(result.confidence > 50, `confidence ${result.confidence} should exceed 50`);
  assert.equal(result.width, 1000);
  assert.equal(result.height, 520);

  for (const expected of ['标题', '数据报告', '状态', '成功', '说明', '测试', '数量', 'list', '42']) {
    assert.ok(result.text.includes(expected), `expected "${expected}" in OCR text, got:\n${result.text}`);
  }
  assert.match(result.text, /json/i);
  assert.ok(nonEmptyLines(result.text).length >= 4, 'should recognize the Chinese block line by line');
});

test('switching languages reinitializes the worker and can switch back', { skip: !hasEng && missingLangReason }, async () => {
  // The previous test may have switched the worker to chi_sim+eng; this call
  // must reinitialize to eng and still read the clean fixture correctly.
  const base64 = await fixtureBase64('json-clean-900x420.png');
  const result = await engine.recognize({ base64, langs: 'eng' });
  assert.equal(result.langs, 'eng');
  assert.match(result.text, /name/i);
  assert.match(result.text, /json-studio/i);
  assert.ok(result.confidence > 50);
});

test('concurrent recognize() calls are serialized and both succeed', { skip: !hasEng && missingLangReason }, async () => {
  const base64 = await fixtureBase64('json-lowres-600w.png');
  const [first, second] = await Promise.all([
    engine.recognize({ base64 }),
    engine.recognize({ base64 }),
  ]);
  for (const result of [first, second]) {
    assert.ok(result.ms > 0);
    assert.ok(result.confidence > 50);
    assert.match(result.text, /name/i);
    assert.match(result.text, /"list"/i);
  }
});

test('invalid inputs reject with descriptive errors', async () => {
  const pngBase64 = await fixtureBase64('json-lowres-600w.png');

  await assert.rejects(() => engine.recognize({}), /base64|empty/i);
  await assert.rejects(() => engine.recognize({ base64: '' }), /empty/i);
  await assert.rejects(() => engine.recognize({ base64: 'not base64 @@' }), /base64/i);
  await assert.rejects(
    () => engine.recognize({ base64: Buffer.from('this is not an image').toString('base64') }),
    /magic bytes|Unsupported image/i,
  );
  await assert.rejects(
    () => engine.recognize({ base64: pngBase64, mime: 'image/svg+xml' }),
    /MIME type/i,
  );
  await assert.rejects(
    () => engine.recognize({ base64: pngBase64, mime: 'image/jpeg' }),
    /mismatch/i,
  );
  await assert.rejects(
    () => engine.recognize({ base64: pngBase64, langs: 'zz_missing' }),
    /missing|Available/i,
  );
});

test('dispose() terminates the worker and is idempotent', async () => {
  if (hasEng) {
    assert.equal(engine.describe().ready, true, 'worker should exist before dispose');
  }

  await engine.dispose();
  assert.equal(engine.describe().ready, false);
  await engine.dispose(); // second call must not throw

  await assert.rejects(() => engine.recognize({ base64: 'AAAA' }), /disposed/i);
});
