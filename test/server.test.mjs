import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createNutritionServer } from '../server.mjs';

const workspace = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = path.join(workspace, '.test-tmp');
const apiKey = 'server-test-secret-never-log';
const prompt = '依照照片與備註估算營養；實物缺少資料時合理估算，包裝未標示的項目填 0。';
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
// Sufficient JPEG SOI/signature bytes for the server's content-type validation.
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function food(overrides = {}) {
  return {
    name: '白飯',
    estimated_weight_g: 100,
    calories_kcal: 130,
    protein_g: 2.4,
    fat_g: 0.3,
    carbs_g: 28,
    fiber_g: 0.4,
    sugar_g: 0.1,
    sodium_mg: 2,
    confidence: 'medium',
    assumptions: ['熟重約 100 公克'],
    ...overrides,
  };
}

function analysis(items = [food()], overrides = {}) {
  return {
    is_food: true,
    meal_name: '測試餐點',
    items,
    uncertainty_notes: ['份量為照片估算。'],
    report_crop_box: { top: 100, left: 150, bottom: 900, right: 850, confidence: 'medium' },
    photo_assessments: [{
      photo_index: 0,
      role: 'food',
      subject_identity: '測試餐點',
      visible_item_count: items.length,
      include_in_report: true,
      report_crop_box: { top: 100, left: 150, bottom: 900, right: 850, confidence: 'medium' },
    }],
    ...overrides,
  };
}

function geminiPayload(value = analysis()) {
  return {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  };
}

function geminiSuccess(value = analysis()) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => geminiPayload(value),
  };
}

function geminiFailure(status, onBodyRead = () => {}) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => {
      onBodyRead();
      throw new Error('RAW-UPSTREAM-BODY must never be read');
    },
  };
}

function image(overrides = {}) {
  return {
    name: 'meal.png',
    mimeType: 'image/png',
    dataBase64: pngBytes.toString('base64'),
    note: '',
    ...overrides,
  };
}

function requestedModel(url) {
  return new URL(url).pathname.split('/models/')[1].replace(':generateContent', '');
}

async function fixture(t, {
  dotenv = `GEMINI_API_KEY=${apiKey}\nGEMINI_MODEL=gemini-primary-test\nGEMINI_FALLBACK_MODEL=gemini-fallback-test\n`,
  fetchImpl = async () => geminiSuccess(),
} = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const baseDir = await mkdtemp(path.join(temporaryRoot, 'server-'));
  const publicDir = path.join(baseDir, 'public');
  await mkdir(publicDir);
  await Promise.all([
    writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Nutrition fixture</title>', 'utf8'),
    writeFile(path.join(publicDir, 'styles.css'), 'body { color: green; }\n', 'utf8'),
    writeFile(path.join(publicDir, 'app.js'), 'globalThis.fixtureLoaded = true;\n', 'utf8'),
    writeFile(path.join(publicDir, 'app.bundle.js'), 'globalThis.fixtureBundleLoaded = true;\n', 'utf8'),
    writeFile(path.join(publicDir, 'manifest.webmanifest'), '{"name":"fixture"}\n', 'utf8'),
    writeFile(path.join(publicDir, 'app-icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n', 'utf8'),
    writeFile(path.join(publicDir, 'service-worker.js'), 'self.fixtureWorker = true;\n', 'utf8'),
    writeFile(path.join(baseDir, 'prompt.txt'), '\uFEFF' + prompt, 'utf8'),
    ...(dotenv === null ? [] : [writeFile(path.join(baseDir, '.env'), dotenv, 'utf8')]),
  ]);

  const logs = [];
  const server = createNutritionServer({
    baseDir,
    env: {},
    fetchImpl,
    logger: message => logs.push(String(message)),
    maxAttempts: 1,
    sleepImpl: async () => { throw new Error('maxAttempts=1 must not sleep'); },
    randomImpl: () => 0,
    nowImpl: () => Date.parse('2026-09-19T00:00:00Z'),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    const resolved = path.resolve(baseDir);
    assert.ok(resolved.startsWith(path.resolve(temporaryRoot) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  });

  return {
    baseDir,
    baseUrl,
    logs,
    get: route => fetch(baseUrl + route),
    head: route => fetch(baseUrl + route, { method: 'HEAD' }),
    post: (payload, headers = { 'Content-Type': 'application/json' }) => fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers,
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }),
  };
}

function rawRequest(baseUrl, route, { method = 'GET', headers = {}, body = '' } = {}) {
  const url = new URL(route, baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('serves only known static assets with HEAD and browser security headers', async t => {
  const current = await fixture(t);
  const expected = [
    ['/', 'text/html; charset=utf-8', 'Nutrition fixture'],
    ['/index.html', 'text/html; charset=utf-8', 'Nutrition fixture'],
    ['/styles.css', 'text/css; charset=utf-8', 'color: green'],
    ['/app.js', 'text/javascript; charset=utf-8', 'fixtureLoaded'],
    ['/app.bundle.js', 'text/javascript; charset=utf-8', 'fixtureBundleLoaded'],
    ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8', 'fixture'],
    ['/app-icon.svg', 'image/svg+xml', '<svg'],
    ['/service-worker.js', 'text/javascript; charset=utf-8', 'fixtureWorker'],
  ];

  for (const [route, contentType, text] of expected) {
    const response = await current.get(route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('content-type'), contentType, route);
    assert.match(await response.text(), new RegExp(text), route);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }

  const head = await current.head('/app.js');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength('globalThis.fixtureLoaded = true;\n'));

  for (const route of ['/.env', '/prompt.txt', '/data/meal.png', '/%2e%2e%2f.env', '/favicon.ico']) {
    assert.equal((await current.get(route)).status, 404, route);
  }
});

test('health endpoint and route method restrictions are explicit', async t => {
  const current = await fixture(t);
  const health = await current.get('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const healthHead = await current.head('/api/health');
  assert.equal(healthHead.status, 200);
  assert.equal(await healthHead.text(), '');

  const healthPost = await fetch(current.baseUrl + '/api/health', { method: 'POST' });
  assert.equal(healthPost.status, 405);
  assert.equal(healthPost.headers.get('allow'), 'GET, HEAD');

  const analyzeGet = await current.get('/api/analyze');
  assert.equal(analyzeGet.status, 405);
  assert.equal(analyzeGet.headers.get('allow'), 'POST');

  const historyPost = await fetch(current.baseUrl + '/api/history', { method: 'POST' });
  assert.equal(historyPost.status, 405);
  assert.equal(historyPost.headers.get('allow'), 'GET, HEAD');

  const staticPost = await fetch(current.baseUrl + '/', { method: 'POST' });
  assert.equal(staticPost.status, 405);
  assert.equal(staticPost.headers.get('allow'), 'GET, HEAD');
});

test('analyzes one image with its note and returns locally calculated totals', async t => {
  let calls = 0;
  const value = analysis([food({ calories_kcal: 131.25, protein_g: 2.45 })]);
  const current = await fixture(t, { fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(requestedModel(url), 'gemini-primary-test');
    assert.equal(options.headers['x-goog-api-key'], apiKey);
    assert.ok(!url.includes(apiKey));
    const request = JSON.parse(options.body);
    assert.equal(request.contents[0].parts[1].inlineData.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(request.contents[0].parts[1].inlineData.data, 'base64'), pngBytes);
    assert.ok(request.contents[0].parts.at(-1).text.includes(prompt));
    assert.ok(request.contents[0].parts.at(-1).text.includes('白飯約 100g'));
    assert.ok(!options.body.includes(apiKey));
    return geminiSuccess(value);
  } });

  const response = await current.post({ images: [image({ note: '白飯約 100g' })] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls, 1);
  assert.equal(body.model, 'gemini-primary-test');
  assert.equal(body.requestedModel, 'gemini-primary-test');
  assert.equal(body.photos.length, 1);
  assert.equal(body.photos[0].name, 'meal.png');
  assert.equal(body.photos[0].model, 'gemini-primary-test');
  assert.deepEqual(body.photos[0].analysis.report_crop_box, value.photo_assessments[0].report_crop_box);
  assert.equal(body.photos[0].totals.calories_kcal, 0);
  assert.equal(body.meals[0].note, '白飯約 100g');
  assert.equal(body.totals.protein_g, 2.5);
  assert.ok(!JSON.stringify(body).includes(apiKey));
});

test('reuses an unchanged meal and reanalyzes it when its shared note changes', async t => {
  let calls = 0;
  const current = await fixture(t, { fetchImpl: async () => {
    calls += 1;
    return geminiSuccess(analysis([food({ calories_kcal: 100 + calls })], {
      photo_assessments: [0, 1].map(photo_index => ({
        photo_index, role: photo_index ? 'nutrition_label' : 'product_front', subject_identity: '燕麥', visible_item_count: 1, include_in_report: photo_index === 0,
        report_crop_box: { top: 100, left: 150, bottom: 900, right: 850, confidence: 'medium' },
      })),
    }));
  } });

  const firstImages = [
    image({ name: 'breakfast-front.png', mealType: 'breakfast' }),
    image({ name: 'breakfast-label.png', mealType: 'breakfast' }),
  ];
  const firstResponse = await current.post({ images: firstImages, mealNotes: { breakfast: '燕麥一碗' } });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(calls, 1);
  assert.deepEqual(first.cache, { reused: 0, analyzed: 1 });
  assert.deepEqual(first.photos.map(photo => photo.reused), [false, false]);

  const unchangedResponse = await current.post({ images: firstImages, mealNotes: { breakfast: '燕麥一碗' } });
  assert.equal(unchangedResponse.status, 200);
  const unchanged = await unchangedResponse.json();
  assert.equal(calls, 1, 'unchanged meal must not call Gemini again');
  assert.deepEqual(unchanged.cache, { reused: 1, analyzed: 0 });
  assert.deepEqual(unchanged.photos.map(photo => photo.reused), [true, true]);
  assert.deepEqual(unchanged.totals, first.totals);

  const forcedResponse = await current.post({ images: firstImages, mealNotes: { breakfast: '燕麥一碗' }, force: true });
  assert.equal(forcedResponse.status, 200);
  const forced = await forcedResponse.json();
  assert.equal(calls, 2, 'force must bypass the unchanged meal cache');
  assert.deepEqual(forced.cache, { reused: 0, analyzed: 1 });

  const changedResponse = await current.post({ images: firstImages, mealNotes: { breakfast: '燕麥半碗' } });
  assert.equal(changedResponse.status, 200);
  const changed = await changedResponse.json();
  assert.equal(calls, 3, 'changing the shared meal note must reanalyze that meal');
  assert.deepEqual(changed.cache, { reused: 0, analyzed: 1 });
  assert.deepEqual(changed.photos.map(photo => photo.reused), [false, false]);
  assert.ok(current.logs.some(message => message.includes('未變更，沿用先前分析結果')));
});

test('saves date-named JSON history and allows the same day to be loaded and edited', async t => {
  let calls = 0;
  const current = await fixture(t, { fetchImpl: async () => {
    calls += 1;
    return geminiSuccess();
  } });
  const date = '2026-09-20';

  const firstResponse = await current.post({
    date,
    images: [image({ name: 'breakfast.png', mealType: 'breakfast', note: '燕麥一碗' })],
  });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.date, date);
  assert.equal(calls, 1);

  const historyPath = path.join(current.baseDir, 'history', `${date}.json`);
  const firstRecord = JSON.parse(await readFile(historyPath, 'utf8'));
  assert.equal(firstRecord.version, 1);
  assert.equal(firstRecord.date, date);
  assert.equal(firstRecord.savedAt, '2026-09-19T00:00:00.000Z');
  assert.equal(firstRecord.images[0].note, '燕麥一碗');
  assert.equal(firstRecord.images[0].dataBase64, pngBytes.toString('base64'));
  assert.equal(firstRecord.result.date, date);

  const listResponse = await current.get('/api/history');
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), { dates: [date] });
  const recordResponse = await current.get(`/api/history/${date}`);
  assert.equal(recordResponse.status, 200);
  assert.deepEqual(await recordResponse.json(), firstRecord);

  const editedResponse = await current.post({
    date,
    images: [image({ name: 'breakfast.png', mealType: 'breakfast', note: '燕麥半碗，不加糖' })],
  });
  assert.equal(editedResponse.status, 200);
  assert.equal(calls, 2, 'editing the note should reanalyze only that photo');
  const editedRecord = JSON.parse(await readFile(historyPath, 'utf8'));
  assert.equal(editedRecord.images[0].note, '燕麥半碗，不加糖');
  assert.equal(editedRecord.images.length, 1);

  const missingResponse = await current.get('/api/history/2026-09-21');
  assert.equal(missingResponse.status, 404);
});

test('saves a draft history record before nutrition analysis', async t => {
  let geminiCalls = 0;
  const current = await fixture(t, { fetchImpl: async () => {
    geminiCalls += 1;
    return geminiSuccess();
  } });
  const date = '2026-09-21';
  const draft = {
    date,
    images: [image({ name: 'dinner.png', mealType: 'dinner', note: '剛輸入的晚餐備註' })],
    result: null,
  };
  const saved = await fetch(current.baseUrl + `/api/history/${date}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { saved: true, date });
  assert.equal(geminiCalls, 0, 'draft autosave must not call Gemini');

  const loaded = await current.get(`/api/history/${date}`);
  assert.equal(loaded.status, 200);
  const record = await loaded.json();
  assert.equal(record.images[0].note, '剛輸入的晚餐備註');
  assert.equal(record.result, null);
  assert.deepEqual((await (await current.get('/api/history')).json()).dates, [date]);
});

test('deletes a history JSON when the day has no photos and removes it from the calendar list', async t => {
  const current = await fixture(t);
  const date = '2026-09-21';
  const historyUrl = current.baseUrl + `/api/history/${date}`;
  const saved = await fetch(historyUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date,
      images: [image({ name: 'dinner.png', mealType: 'dinner' })],
      result: null,
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await (await current.get('/api/history')).json()).dates, [date]);

  const deleted = await fetch(historyUrl, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true, date });
  assert.equal((await current.get(`/api/history/${date}`)).status, 404);
  assert.deepEqual((await (await current.get('/api/history')).json()).dates, []);

  const repeated = await fetch(historyUrl, { method: 'DELETE' });
  assert.equal(repeated.status, 200, 'deleting an already-empty date is idempotent');
});

test('an empty history autosave removes an existing JSON instead of keeping a calendar marker', async t => {
  const current = await fixture(t);
  const date = '2026-09-20';
  const historyUrl = current.baseUrl + `/api/history/${date}`;
  await fetch(historyUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, images: [image()], result: null }),
  });
  const emptySave = await fetch(historyUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, images: [], result: null }),
  });
  assert.equal(emptySave.status, 200);
  assert.deepEqual(await emptySave.json(), { deleted: true, date });
  assert.deepEqual((await (await current.get('/api/history')).json()).dates, []);
});

test('keeps a history JSON and calendar marker when a meal has only a shared note', async t => {
  const current = await fixture(t);
  const date = '2026-09-21';
  const historyUrl = current.baseUrl + `/api/history/${date}`;
  const saved = await fetch(historyUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date,
      images: [],
      mealNotes: { dinner: '牛肉麵一碗，沒有拍照' },
      result: null,
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { saved: true, date });
  assert.deepEqual((await (await current.get('/api/history')).json()).dates, [date]);
  const record = await (await current.get(`/api/history/${date}`)).json();
  assert.equal(record.images.length, 0);
  assert.equal(record.mealNotes.dinner, '牛肉麵一碗，沒有拍照');
});

test('sends front and nutrition-label photos together, preserves order, and counts the item once', async t => {
  const calls = [];
  const value = analysis([food({ name: '無糖豆漿', calories_kcal: 120, protein_g: 9 })], {
    photo_assessments: [
      { photo_index: 0, role: 'product_front', subject_identity: '無糖豆漿', visible_item_count: 1, include_in_report: true, report_crop_box: { top: 50, left: 100, bottom: 950, right: 900, confidence: 'high' } },
      { photo_index: 1, role: 'nutrition_label', subject_identity: '無糖豆漿', visible_item_count: 1, include_in_report: false, report_crop_box: { top: 80, left: 120, bottom: 920, right: 880, confidence: 'high' } },
    ],
  });
  const current = await fixture(t, { fetchImpl: async (url, options) => {
    calls.push(requestedModel(url));
    const request = JSON.parse(options.body);
    assert.equal(request.contents[0].parts.filter(part => part.inlineData).length, 2);
    assert.match(request.contents[0].parts.at(-1).text, /同一瓶豆漿/);
    return geminiSuccess(value);
  } });
  const response = await current.post({
    images: [
      image({ name: 'front.png', mealType: 'breakfast' }),
      image({ name: 'label.png', mealType: 'breakfast' }),
    ],
    mealNotes: { breakfast: '同一瓶豆漿' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(calls, ['gemini-primary-test']);
  assert.deepEqual(body.photos.map(photo => [photo.name, photo.role]), [
    ['front.png', 'product_front'],
    ['label.png', 'nutrition_label'],
  ]);
  assert.equal(body.meals[0].items.length, 1);
  assert.equal(body.meals[0].items[0].source_photo, 'front.png');
  assert.equal(body.totals.calories_kcal, 120);
});

test('rejects multiple meal periods because the app submits each meal separately', async t => {
  let calls = 0;
  const current = await fixture(t, { fetchImpl: async () => { calls += 1; return geminiSuccess(); } });
  const response = await current.post({ images: [
    image({ name: 'breakfast.png', mealType: 'breakfast' }),
    image({ name: 'lunch.png', mealType: 'lunch' }),
  ] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /一個餐次/);
  assert.equal(calls, 0);
});

test('analyzes a text-only meal without requiring a photo', async t => {
  const value = analysis([food({ name: '牛肉麵', calories_kcal: 620 })], { photo_assessments: [] });
  const current = await fixture(t, { fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.contents[0].parts.some(part => part.inlineData), false);
    assert.match(request.contents[0].parts.at(-1).text, /牛肉麵一碗/);
    return geminiSuccess(value);
  } });
  const response = await current.post({ images: [], mealNotes: { dinner: '牛肉麵一碗' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.photos.length, 0);
  assert.equal(body.meals[0].id, 'dinner');
  assert.equal(body.meals[0].note, '牛肉麵一碗');
  assert.equal(body.meals[0].items[0].source_photo, '文字備註');
});

test('rejects malformed and unsafe input before calling Gemini', async t => {
  let calls = 0;
  const current = await fixture(t, { fetchImpl: async () => {
    calls += 1;
    return geminiSuccess();
  } });
  const thirtyOneImages = Array.from({ length: 31 }, (_, index) => image({ name: `meal-${index}.png` }));
  const elevenLunchImages = Array.from({ length: 11 }, (_, index) => image({
    name: `lunch-${index}.png`,
    mealType: 'lunch',
  }));
  const cases = [
    ['wrong content type', JSON.stringify({ images: [image()] }), { 'Content-Type': 'text/plain' }],
    ['malformed JSON', '{', { 'Content-Type': 'application/json' }],
    ['array root', '[]', { 'Content-Type': 'application/json' }],
    ['empty image list', JSON.stringify({ images: [] }), { 'Content-Type': 'application/json' }],
    ['extra top-level field', JSON.stringify({ images: [image()], admin: true }), { 'Content-Type': 'application/json' }],
    ['prototype key', `{"images":[${JSON.stringify(image())}],"__proto__":{"polluted":true}}`, { 'Content-Type': 'application/json' }],
    ['extra image field', JSON.stringify({ images: [image({ unexpected: true })] }), { 'Content-Type': 'application/json' }],
    ['missing required field', JSON.stringify({ images: [{ name: 'meal.png', mimeType: 'image/png' }] }), { 'Content-Type': 'application/json' }],
    ['bad base64', JSON.stringify({ images: [image({ dataBase64: 'not base64!' })] }), { 'Content-Type': 'application/json' }],
    ['unsupported media type', JSON.stringify({ images: [image({ mimeType: 'image/gif' })] }), { 'Content-Type': 'application/json' }],
    ['MIME and magic mismatch', JSON.stringify({ images: [image({ dataBase64: jpegBytes.toString('base64') })] }), { 'Content-Type': 'application/json' }],
    ['too many images in a day', JSON.stringify({ images: thirtyOneImages }), { 'Content-Type': 'application/json' }],
    ['too many images in one meal', JSON.stringify({ images: elevenLunchImages }), { 'Content-Type': 'application/json' }],
    ['unsupported meal period', JSON.stringify({ images: [image({ mealType: 'brunch' })] }), { 'Content-Type': 'application/json' }],
    ['invalid date', JSON.stringify({ date: '2026-02-30', images: [image()] }), { 'Content-Type': 'application/json' }],
    ['long note', JSON.stringify({ images: [image({ note: '字'.repeat(2001) })] }), { 'Content-Type': 'application/json' }],
    ['unsafe filename', JSON.stringify({ images: [image({ name: '../meal.png' })] }), { 'Content-Type': 'application/json' }],
    ['long filename', JSON.stringify({ images: [image({ name: 'a'.repeat(121) })] }), { 'Content-Type': 'application/json' }],
  ];

  for (const [name, body, headers] of cases) {
    const response = await current.post(body, headers);
    assert.equal(response.status, 400, name);
    const payload = await response.json();
    assert.equal(typeof payload.error, 'string', name);
    assert.ok(payload.error.length > 0, name);
  }
  assert.equal(calls, 0);
});

test('rejects an oversized declared request without buffering it', async t => {
  const current = await fixture(t);
  const response = await rawRequest(current.baseUrl, '/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '55000001' },
  });
  assert.equal(response.status, 413);
  assert.equal(typeof JSON.parse(response.body).error, 'string');
});

test('asks the client for an API key when the server has no fallback key', async t => {
  let calls = 0;
  const current = await fixture(t, {
    dotenv: null,
    fetchImpl: async () => { calls += 1; return geminiSuccess(); },
  });
  const response = await current.post({ images: [image()] });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.match(body.error, /API key/);
  assert.ok(!JSON.stringify(body).includes('stack'));
  assert.equal(calls, 0);
});

test('uses a client-provided API key without storing it in the response', async t => {
  const clientApiKey = 'client-provided-key-never-bundle-123456';
  let calls = 0;
  const current = await fixture(t, {
    dotenv: null,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers['x-goog-api-key'], clientApiKey);
      return geminiSuccess();
    },
  });
  const response = await current.post({ images: [image()] }, {
    'Content-Type': 'application/json',
    'X-Gemini-Api-Key': clientApiKey,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(body).includes(clientApiKey));
});

test('aborts the upstream Gemini request when the web client cancels analysis', async t => {
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let upstreamSignal;
  const current = await fixture(t, {
    fetchImpl: async (_url, options) => {
      upstreamSignal = options.signal;
      markStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const request = fetch(current.baseUrl + '/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: [image()] }),
    signal: controller.signal,
  });

  await started;
  controller.abort();
  await assert.rejects(request, error => error?.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(upstreamSignal.aborted, true);
  assert.ok(current.logs.some(line => line.includes('用戶端已中止')));
});

test('does not copy device-managed history into the server history folder', async t => {
  const current = await fixture(t);
  const date = '2026-09-18';
  const response = await current.post({ date, images: [image()] }, {
    'Content-Type': 'application/json',
    'X-Nutrition-History': 'device',
  });
  assert.equal(response.status, 200);
  assert.equal((await current.get(`/api/history/${date}`)).status, 404);
});

test('allows Capacitor API preflights and rejects unrelated origins', async t => {
  const current = await fixture(t);
  const allowed = await fetch(current.baseUrl + '/api/analyze', {
    method: 'OPTIONS',
    headers: {
      Origin: 'capacitor://localhost',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-gemini-api-key',
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  assert.match(allowed.headers.get('access-control-allow-headers'), /X-Gemini-Api-Key/i);
  assert.match(allowed.headers.get('access-control-allow-headers'), /X-Nutrition-History/i);

  const rejected = await fetch(current.baseUrl + '/api/analyze', {
    method: 'OPTIONS',
    headers: { Origin: 'https://unrelated.example' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

test('maps upstream failures safely and preserves only actionable 429/503 statuses', async t => {
  for (const [upstreamStatus, expectedStatus, expectedCalls] of [
    [400, 502, 1],
    [429, 429, 1],
    [503, 503, 2],
  ]) {
    await t.test(`upstream HTTP ${upstreamStatus}`, async child => {
      let calls = 0;
      let bodyReads = 0;
      const current = await fixture(child, { fetchImpl: async () => {
        calls += 1;
        return geminiFailure(upstreamStatus, () => { bodyReads += 1; });
      } });
      const response = await current.post({ images: [image()] });
      assert.equal(response.status, expectedStatus);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ['error']);
      assert.ok(!body.error.includes(apiKey));
      assert.ok(!body.error.includes('RAW-UPSTREAM-BODY'));
      assert.ok(!JSON.stringify(body).includes('stack'));
      assert.ok(!current.logs.join('\n').includes(apiKey));
      assert.ok(!current.logs.join('\n').includes('RAW-UPSTREAM-BODY'));
      assert.equal(bodyReads, 0, 'HTTP error bodies must not be read');
      assert.equal(calls, expectedCalls);
    });
  }
});
