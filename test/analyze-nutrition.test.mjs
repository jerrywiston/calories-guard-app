import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { main, NUTRIENTS, readConfig, RESPONSE_SCHEMA } from '../analyze-nutrition.mjs';

const workspace = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = path.join(workspace, '.test-tmp');
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const webpBytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const prompt = '請依照片和文字說明估算各項食物的營養；實物缺少資料時合理估算，包裝未標示的項目填 0。';
const apiKey = 'offline-test-key-never-use-for-network';

function item(overrides = {}) {
  return {
    name: '白飯', portion_description: '', estimated_weight_g: 150, calories_kcal: 195,
    protein_g: 4.1, fat_g: 0.4, carbs_g: 43, fiber_g: 0.6,
    sugar_g: 0.1, sodium_mg: 2, confidence: 'medium',
    assumptions: ['熟重約 150 公克'], ...overrides,
  };
}

function analysis(items = [item()]) {
  return {
    is_food: true,
    meal_name: '午餐',
    items,
    uncertainty_notes: ['照片無法確定額外調味料。'],
    report_crop_box: { top: 100, left: 150, bottom: 900, right: 850, confidence: 'medium' },
    photo_assessments: [{
      photo_index: 0,
      role: 'food',
      subject_identity: '測試餐點',
      visible_item_count: items.length,
      include_in_report: true,
      report_crop_box: { top: 100, left: 150, bottom: 900, right: 850, confidence: 'medium' },
    }],
  };
}

function responsePayload(value = analysis()) {
  return {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80, totalTokenCount: 200 },
  };
}

function successfulFetch(payload = responsePayload()) {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

async function fixture(t, { images = { 'meal.png': pngBytes }, dotenv = true } = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const baseDir = await mkdtemp(path.join(temporaryRoot, 'nutrition-'));
  t.after(async () => {
    const resolved = path.resolve(baseDir);
    assert.ok(resolved.startsWith(path.resolve(temporaryRoot) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  });
  await mkdir(path.join(baseDir, 'data'));
  await writeFile(path.join(baseDir, 'prompt.txt'), '\uFEFF' + prompt, 'utf8');
  if (dotenv) {
    await writeFile(path.join(baseDir, '.env'), `GEMINI_API_KEY=${apiKey}\nGEMINI_MODEL=gemini-offline-test\n`, 'utf8');
  }
  for (const [filename, bytes] of Object.entries(images)) {
    await writeFile(path.join(baseDir, 'data', filename), bytes);
  }
  const logs = [];
  const errors = [];
  const sleeps = [];
  return {
    baseDir, logs, errors, sleeps,
    run: (argv = [], fetchImpl = successfulFetch(), extra = {}) => main(argv, {
      baseDir, env: {}, fetchImpl, log: text => logs.push(text), errorLog: text => errors.push(text),
      maxAttempts: 4, sleepImpl: async milliseconds => { sleeps.push(milliseconds); },
      randomImpl: () => 0, nowImpl: () => Date.parse('2026-09-19T00:00:00Z'), ...extra,
    }),
  };
}

async function readReports(baseDir) {
  const root = path.join(baseDir, 'results');
  const runs = await readdir(root);
  assert.equal(runs.length, 1, 'one directory should hold all reports from a run');
  const directory = path.join(root, runs[0]);
  const files = (await readdir(directory)).sort();
  const reports = [];
  for (const filename of files.filter(name => name.endsWith('.json'))) {
    reports.push(JSON.parse(await readFile(path.join(directory, filename), 'utf8')));
  }
  return { directory, files, reports };
}

async function assertNoReports(baseDir) {
  await assert.rejects(readdir(path.join(baseDir, 'results')), { code: 'ENOENT' });
}

test('sends image bytes, paired annotation and prompt; writes JSON and Markdown with calculated totals', async t => {
  const current = await fixture(t);
  const annotation = '白飯 150 g，雞胸肉 100 g；未額外加油。';
  await writeFile(path.join(current.baseDir, 'data', 'meal.annotation.txt'), '\uFEFF' + annotation + '\n');
  await writeFile(path.join(current.baseDir, 'data', 'meal.txt'), 'this lower-priority annotation must not be sent');
  const value = analysis([
    item(),
    item({ name: '雞胸肉', estimated_weight_g: 100, calories_kcal: 165, protein_g: 31,
      fat_g: 3.6, carbs_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 74 }),
  ]);
  let calls = 0;
  const exitCode = await current.run(['--model', 'models/gemini-selected-test'], async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-selected-test:generateContent');
    assert.ok(!url.includes(apiKey));
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-goog-api-key'], apiKey);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    const request = JSON.parse(options.body);
    assert.equal(request.contents[0].role, 'user');
    const parts = request.contents[0].parts;
    assert.equal(parts[0].inlineData.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(parts[0].inlineData.data, 'base64'), pngBytes);
    assert.ok(parts[1].text.includes(prompt));
    assert.ok(parts[1].text.includes(annotation));
    assert.ok(parts[1].text.includes('meal.png'));
    assert.ok(!parts[1].text.includes('lower-priority'));
    assert.ok(!parts[1].text.includes('\uFEFF'));
    assert.equal(request.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(request.generationConfig.responseJsonSchema, RESPONSE_SCHEMA);
    assert.equal(RESPONSE_SCHEMA.properties.items.items.properties.sodium_mg.type, 'number');
    assert.equal(RESPONSE_SCHEMA.properties.items.items.properties.portion_description.type, 'string');
    assert.equal(RESPONSE_SCHEMA.properties.report_crop_box.properties.right.maximum, 1000);
    assert.ok(RESPONSE_SCHEMA.required.includes('report_crop_box'));
    return { ok: true, status: 200, json: async () => responsePayload(value) };
  });
  assert.equal(exitCode, 0, current.errors.join('\n'));
  assert.equal(calls, 1);
  assert.deepEqual(current.errors, []);
  const { directory, files, reports } = await readReports(current.baseDir);
  assert.deepEqual(files, ['meal.png.nutrition.json', 'meal.png.nutrition.md']);
  const report = reports[0];
  assert.equal(report.image, 'meal.png');
  assert.equal(report.model, 'gemini-selected-test');
  assert.equal(report.requested_model, 'gemini-selected-test');
  assert.equal(report.annotation_file, 'meal.annotation.txt');
  assert.equal(report.annotation, annotation);
  assert.equal(report.prompt, prompt);
  assert.deepEqual(report.analysis, value);
  assert.deepEqual(report.totals, {
    calories_kcal: 360, protein_g: 35.1, fat_g: 4, carbs_g: 43,
    fiber_g: 0.6, sugar_g: 0.1, sodium_mg: 76,
  });
  assert.deepEqual(report.usage, responsePayload().usageMetadata);
  assert.ok(Number.isFinite(Date.parse(report.created_at)));
  const markdown = await readFile(path.join(directory, 'meal.png.nutrition.md'), 'utf8');
  assert.match(markdown, /# 午餐/);
  assert.match(markdown, /\*\*合計\*\*.*360.*35\.1.*76/);
  assert.ok(markdown.includes(value.uncertainty_notes[0]));
  assert.ok(!JSON.stringify(report).includes(apiKey));
  assert.ok(!markdown.includes(apiKey));
  assert.ok(!current.logs.join('\n').includes(apiKey));
});

test('same-stem images with different extensions produce separate reports and use .txt fallback', async t => {
  const current = await fixture(t, { images: { 'meal.png': pngBytes, 'meal.webp': webpBytes } });
  const annotation = '午餐一份';
  await writeFile(path.join(current.baseDir, 'data', 'meal.txt'), annotation);
  const images = [];
  const code = await current.run([], async (_url, options) => {
    const parts = JSON.parse(options.body).contents[0].parts;
    images.push(parts[0].inlineData);
    assert.ok(parts[1].text.includes(annotation));
    return { ok: true, status: 200, json: async () => responsePayload() };
  });
  assert.equal(code, 0, current.errors.join('\n'));
  assert.equal(images.length, 2);
  assert.deepEqual(new Set(images.map(image => image.mimeType)), new Set(['image/png', 'image/webp']));
  assert.deepEqual(Buffer.from(images.find(image => image.mimeType === 'image/webp').data, 'base64'), webpBytes);
  const { files, reports } = await readReports(current.baseDir);
  assert.deepEqual(files, [
    'meal.png.nutrition.json', 'meal.png.nutrition.md',
    'meal.webp.nutrition.json', 'meal.webp.nutrition.md',
  ]);
  assert.deepEqual(new Set(reports.map(report => report.image)), new Set(['meal.png', 'meal.webp']));
  assert.ok(reports.every(report => report.annotation_file === 'meal.txt'));
});

test('dry-run needs no key and makes no network calls or report directories', async t => {
  const current = await fixture(t, { dotenv: false });
  const annotation = '乾跑模式餐點說明';
  await writeFile(path.join(current.baseDir, 'data', 'meal.txt'), annotation);
  let calls = 0;
  const code = await current.run(['--dry-run'], async () => {
    calls += 1;
    throw new Error('network must not be called');
  });
  assert.equal(code, 0);
  assert.equal(calls, 0);
  assert.deepEqual(current.errors, []);
  assert.ok(current.logs.join('\n').includes(annotation));
  assert.ok(current.logs.join('\n').includes(prompt));
  await assertNoReports(current.baseDir);
});

test('a real analysis with no key fails before any request or report write', async t => {
  const current = await fixture(t, { dotenv: false });
  let calls = 0;
  await assert.rejects(current.run([], async () => { calls += 1; }), /GEMINI_API_KEY/);
  assert.equal(calls, 0);
  await assertNoReports(current.baseDir);
});

const rejectedResponses = [
  ['invalid JSON', { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{unfinished' }] } }] }],
  ['truncated response even when its text is valid JSON', {
    candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify(analysis()) }] } }],
  }],
  ['blocked prompt even when a candidate is included', {
    ...responsePayload(), promptFeedback: { blockReason: 'SAFETY' },
  }],
  ['negative nutrient estimate', responsePayload(analysis([item({ calories_kcal: -1 })]))],
  ['null nutrient estimate', responsePayload(analysis([item({ sodium_mg: null })]))],
  ['missing nutrient field', responsePayload(analysis([item({ protein_g: undefined })]))],
  ['non-food image', responsePayload({ ...analysis([]), is_food: false })],
];

for (const [name, payload] of rejectedResponses) {
  test(`rejects ${name} without writing a nutrition report`, async t => {
    const current = await fixture(t);
    let calls = 0;
    assert.equal(await current.run([], async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => payload };
    }), 1);
    assert.equal(calls, 1, 'invalid analysis must not retry or switch models');
    assert.deepEqual(current.sleeps, []);
    assert.equal(current.errors.length, 1);
    assert.ok(current.errors[0].includes('meal.png'));
    await assertNoReports(current.baseDir);
  });
}

test('packaged nutrients absent from the label use zero and totals stay numeric', async t => {
  const current = await fixture(t);
  const value = analysis([item(), item({ name: '包裝醬汁', sodium_mg: 0, sugar_g: 0 })]);
  assert.equal(await current.run([], successfulFetch(responsePayload(value))), 0);
  const { directory, reports } = await readReports(current.baseDir);
  assert.equal(reports[0].totals.sodium_mg, 2);
  assert.equal(reports[0].totals.sugar_g, 0.1);
  assert.equal(reports[0].totals.calories_kcal, 390);
  assert.deepEqual(Object.keys(reports[0].totals), Object.keys(NUTRIENTS));
  const markdown = await readFile(path.join(directory, 'meal.png.nutrition.md'), 'utf8');
  const totalsRow = markdown.split('\n').find(line => line.startsWith('| **合計**'));
  assert.match(totalsRow, /390/);
  assert.doesNotMatch(totalsRow, /未知|null/);
});

test('partial failure returns 1 and preserves reports before and after the failure', async t => {
  const current = await fixture(t, { images: {
    'a-success.png': pngBytes, 'b-failure.png': pngBytes, 'c-success.png': pngBytes,
  } });
  const requested = [];
  const code = await current.run([], async (_url, options) => {
    const text = JSON.parse(options.body).contents[0].parts[1].text;
    requested.push(text);
    if (text.includes('b-failure.png')) {
      return { ok: false, status: 400, json: async () => { throw new Error('error body must not be read'); } };
    }
    return { ok: true, status: 200, json: async () => responsePayload() };
  });
  assert.equal(code, 1);
  assert.equal(requested.length, 3);
  assert.equal(current.errors.length, 1);
  assert.match(current.errors[0], /b-failure\.png.*HTTP 400/);
  assert.deepEqual(current.sleeps, []);
  const { files, reports } = await readReports(current.baseDir);
  assert.equal(files.length, 4);
  assert.ok(files.every(name => !name.startsWith('b-failure')));
  assert.deepEqual(reports.map(report => report.image), ['a-success.png', 'c-success.png']);
});

test('readConfig respects environment precedence, parses a BOM .env, and mutates neither environment', async t => {
  const current = await fixture(t, { dotenv: false });
  const dotenv = '\uFEFF# local configuration\nGEMINI_API_KEY="local key"\nGEMINI_MODEL=gemini-local-test\nGEMINI_FALLBACK_MODEL=gemini-local-fallback\n';
  await writeFile(path.join(current.baseDir, '.env'), dotenv);
  const originalProcess = {
    apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, fallbackModel: process.env.GEMINI_FALLBACK_MODEL,
  };
  const explicitEnv = Object.freeze({
    GEMINI_API_KEY: '  environment key  ', GEMINI_MODEL: 'gemini-env-test',
    GEMINI_FALLBACK_MODEL: '  gemini-env-fallback  ', KEEP: 'original',
  });
  assert.deepEqual(await readConfig(current.baseDir, explicitEnv), {
    apiKey: 'environment key', model: 'gemini-env-test', fallbackModel: 'gemini-env-fallback',
  });
  assert.deepEqual(await readConfig(current.baseDir, Object.freeze({})), {
    apiKey: 'local key', model: 'gemini-local-test', fallbackModel: 'gemini-local-fallback',
  });
  assert.deepEqual(await readConfig(current.baseDir, Object.freeze({ GEMINI_API_KEY: '' })), {
    apiKey: '', model: 'gemini-local-test', fallbackModel: 'gemini-local-fallback',
  });
  assert.equal(explicitEnv.GEMINI_API_KEY, '  environment key  ');
  assert.equal(explicitEnv.GEMINI_FALLBACK_MODEL, '  gemini-env-fallback  ');
  assert.equal(explicitEnv.KEEP, 'original');
  assert.deepEqual({
    apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, fallbackModel: process.env.GEMINI_FALLBACK_MODEL,
  }, originalProcess);
  assert.equal(await readFile(path.join(current.baseDir, '.env'), 'utf8'), dotenv);
});

function requestedModel(url) {
  return new URL(url).pathname.split('/models/')[1].replace(':generateContent', '');
}

function httpFailure(status, retryAfter) {
  return {
    ok: false, status, headers: new Headers(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }),
    json: async () => { throw new Error('HTTP error body must not be read'); },
  };
}

test('503, 503, 200 retries the same model with deterministic backoff and progress logs', async t => {
  const current = await fixture(t);
  const models = [];
  const bodies = [];
  const code = await current.run([], async (url, options) => {
    models.push(requestedModel(url));
    bodies.push(options.body);
    return models.length <= 2 ? httpFailure(503) : successfulFetch()();
  });
  assert.equal(code, 0, current.errors.join('\n'));
  assert.deepEqual(models, Array(3).fill('gemini-offline-test'));
  assert.equal(new Set(bodies).size, 1, 'retry must preserve the complete image and prompt request');
  assert.deepEqual(current.sleeps, [500, 1000]);
  assert.deepEqual(current.logs.filter(line => line.includes('秒後重試')), [
    'gemini-offline-test 發生 HTTP 503；0.5 秒後重試（第 2/4 次）…',
    'gemini-offline-test 發生 HTTP 503；1.0 秒後重試（第 3/4 次）…',
  ]);
  const { reports } = await readReports(current.baseDir);
  assert.equal(reports[0].model, 'gemini-offline-test');
  assert.deepEqual(current.errors, []);
});

for (const [name, retryAfter, delay] of [
  ['seconds', '3', 3000],
  ['HTTP date', 'Sat, 19 Sep 2026 00:00:10 GMT', 10000],
]) {
  test(`honors Retry-After ${name} before retrying`, async t => {
    const current = await fixture(t);
    let calls = 0;
    const code = await current.run([], async () => {
      calls += 1;
      return calls === 1 ? httpFailure(503, retryAfter) : successfulFetch()();
    });
    assert.equal(code, 0, current.errors.join('\n'));
    assert.equal(calls, 2);
    assert.deepEqual(current.sleeps, [delay]);
  });
}

test('exhausted 503 attempts use default fallback and record the actual and requested models', async t => {
  const current = await fixture(t);
  const models = [];
  const code = await current.run([], async url => {
    const model = requestedModel(url);
    models.push(model);
    return model === 'gemini-offline-test' ? httpFailure(503) : successfulFetch()();
  });
  assert.equal(code, 0, current.errors.join('\n'));
  assert.deepEqual(models, [...Array(4).fill('gemini-offline-test'), 'gemini-3.8-flash']);
  assert.deepEqual(current.sleeps, [500, 1000, 2000]);
  assert.equal(current.logs.filter(line => line.includes('改用備援模型 gemini-3.8-flash')).length, 1);
  const { directory, reports } = await readReports(current.baseDir);
  assert.equal(reports[0].model, 'gemini-3.8-flash');
  assert.equal(reports[0].requested_model, 'gemini-offline-test');
  assert.match(await readFile(path.join(directory, 'meal.png.nutrition.md'), 'utf8'), /模型：gemini-3\.8-flash/);
  assert.deepEqual(current.errors, []);
});

test('--fallback-model none stops after exactly maxAttempts instead of switching models', async t => {
  const current = await fixture(t);
  const models = [];
  const code = await current.run(['--fallback-model', 'none'], async url => {
    models.push(requestedModel(url));
    return httpFailure(503);
  }, { maxAttempts: 3 });
  assert.equal(code, 1);
  assert.deepEqual(models, Array(3).fill('gemini-offline-test'));
  assert.deepEqual(current.sleeps, [500, 1000]);
  assert.equal(current.errors.length, 1);
  assert.match(current.errors[0], /HTTP 503.*共嘗試 3 次/);
  assert.ok(current.logs.every(line => !line.includes('改用備援模型')));
  await assertNoReports(current.baseDir);
});

test('network TypeError retries with a fresh AbortSignal and succeeds', async t => {
  const current = await fixture(t);
  const signals = [];
  const models = [];
  const code = await current.run([], async (url, options) => {
    models.push(requestedModel(url));
    signals.push(options.signal);
    if (signals.length === 1) throw new TypeError('fetch failed');
    return successfulFetch()();
  });
  assert.equal(code, 0, current.errors.join('\n'));
  assert.deepEqual(models, Array(2).fill('gemini-offline-test'));
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal instanceof AbortSignal && !signal.aborted));
  assert.notEqual(signals[0], signals[1]);
  assert.deepEqual(current.sleeps, [500]);
  assert.equal(current.logs.filter(line => line.includes('網路連線失敗')).length, 1);
  await readReports(current.baseDir);
});

test('400 fails immediately without retries or fallback', async t => {
  const current = await fixture(t);
  const models = [];
  const code = await current.run([], async url => {
    models.push(requestedModel(url));
    return httpFailure(400);
  });
  assert.equal(code, 1);
  assert.deepEqual(models, ['gemini-offline-test']);
  assert.deepEqual(current.sleeps, []);
  assert.match(current.errors[0], /HTTP 400/);
  await assertNoReports(current.baseDir);
});

test('malformed HTTP 200 response JSON fails without retries or fallback', async t => {
  const current = await fixture(t);
  let calls = 0;
  const code = await current.run([], async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } };
  });
  assert.equal(code, 1);
  assert.equal(calls, 1);
  assert.deepEqual(current.sleeps, []);
  assert.match(current.errors[0], /無法解析的 JSON/);
  await assertNoReports(current.baseDir);
});

test('429 retries the primary model but never switches models when quota errors persist', async t => {
  const current = await fixture(t);
  const models = [];
  const code = await current.run([], async url => {
    models.push(requestedModel(url));
    return httpFailure(429, '2');
  });
  assert.equal(code, 1);
  assert.deepEqual(models, Array(4).fill('gemini-offline-test'));
  assert.deepEqual(current.sleeps, [2000, 2000, 2000]);
  assert.match(current.errors[0], /HTTP 429.*共嘗試 4 次/);
  assert.ok(current.logs.every(line => !line.includes('改用備援模型')));
  await assertNoReports(current.baseDir);
});
