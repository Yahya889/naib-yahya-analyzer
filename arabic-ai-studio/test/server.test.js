'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('../server');

async function withServer(options, run) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('serves the standalone interface with restrictive browser security headers', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await response.text(), /مِداد/);
    assert.equal((await fetch(`${base}/../server.js`)).status, 404);
  });
});

test('reports model configuration and rejects invalid task requests', async () => {
  await withServer({
    model: 'local-test-model',
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/tags');
      return Response.json({ models: [{ name: 'local-test-model' }] });
    }
  }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
      ok: true,
      ollamaAvailable: true,
      modelAvailable: true,
      model: 'local-test-model',
      installCommand: 'ollama pull local-test-model'
    });
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: '', domain: 'أعمال', phase: 'plan' })
    });
    assert.equal(response.status, 400);
  });
});

test('reports missing local model and unavailable Ollama separately', async () => {
  await withServer({
    model: 'missing-model',
    fetchImpl: async () => Response.json({ models: [{ name: 'other-model' }] })
  }, async (base) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, false);
    assert.equal(health.ollamaAvailable, true);
    assert.equal(health.modelAvailable, false);
  });

  await withServer({
    fetchImpl: async () => { throw new Error('Ollama not running'); }
  }, async (base) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ollamaAvailable, false);
    assert.equal(health.modelAvailable, false);
  });
});

test('rejects oversized task bodies before using the local model', async () => {
  let modelCalled = false;
  await withServer({
    fetchImpl: async () => {
      modelCalled = true;
      return Response.json({ message: { content: 'غير متوقع' } });
    }
  }, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'x'.repeat(600000), domain: 'أعمال', phase: 'plan' })
    });
    assert.equal(response.status, 413);
    assert.equal(modelCalled, false);
  });
});

test('rejects cross-origin task requests before contacting the local model', async () => {
  let modelCalled = false;
  await withServer({
    fetchImpl: async () => {
      modelCalled = true;
      return Response.json({ message: { content: 'غير متوقع' } });
    }
  }, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ task: 'اختبار', domain: 'أعمال', phase: 'plan' })
    });
    assert.equal(response.status, 403);
    assert.equal(modelCalled, false);
  });
});

test('sends both task stages only to the configured local model bridge and handles model failures', async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ message: { content: 'إجابة تجريبية' } });
  };
  await withServer({ fetchImpl, ollamaUrl: 'http://127.0.0.1:11434/api/chat', model: 'test-model' }, async (base) => {
    for (const payload of [
      { task: 'أنشئ خطة', domain: 'أعمال', phase: 'plan' },
      { task: 'أنشئ مسودة', domain: 'أعمال', phase: 'execute', plan: 'خطوة أولى' }
    ]) {
      const response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).answer, 'إجابة تجريبية');
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, 'test-model');
    assert.match(requests[0].messages[1].content, /أنشئ خطة/);
    assert.match(requests[1].messages[1].content, /خطوة أولى/);
  });
});
