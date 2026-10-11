const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { createBackupRunner } = require('../src/backups');

test('authenticates users and provides protected document, accounting, and media APIs', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naib-analyzer-'));
  const app = createApp({
    databasePath: path.join(dataDir, 'test.sqlite'),
    storagePath: path.join(dataDir, 'uploads'),
    tokenSecret: 'test-only-token-secret-long-enough'
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options = {}) => fetch(`${base}${url}`, options);
  const authHeaders = (token) => ({ Authorization: ['Bearer', token].join(' ') });
  const json = (method, body, token) => ({
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? authHeaders(token) : {}) },
    body: JSON.stringify(body)
  });

  const status = await request('/api/auth/status');
  assert.deepEqual(await status.json(), { configured: false });
  assert.equal((await request('/api/documents')).status, 401);

  const registration = await request('/api/auth/register', json('POST', {
    username: 'owner',
    password: 'very-long-test-password'
  }));
  assert.equal(registration.status, 201);
  const admin = await registration.json();
  assert.equal((await request('/api/auth/register', json('POST', {
    username: 'another',
    password: 'very-long-test-password'
  }))).status, 403);
  assert.equal((await (await request('/api/auth/me', { headers: authHeaders(admin.token) })).json()).role, 'admin');

  const createdUser = await request('/api/users', json('POST', {
    username: 'staff',
    password: 'another-long-test-password'
  }, admin.token));
  assert.equal(createdUser.status, 201);
  const user = await createdUser.json();
  assert.equal(user.role, 'staff');
  const login = await request('/api/auth/login', json('POST', {
    username: 'staff',
    password: 'another-long-test-password'
  }));
  const staff = await login.json();
  assert.equal((await request('/api/users', { headers: authHeaders(staff.token) })).status, 403);

  const analyzed = await request('/api/documents/analyze', json('POST', {
    title: 'عقد تجريبي',
    content: 'اتفق الطرف الأول والطرف الثاني على توقيع العقد.'
  }, staff.token));
  assert.equal(analyzed.status, 201);
  const document = await analyzed.json();
  assert.equal(document.analysis.score, 29);
  assert.equal(document.analysis.clauses.find((clause) => clause.name === 'التوقيع').present, true);
  assert.equal((await request('/api/documents', { headers: authHeaders(staff.token) })).status, 200);

  const invalidDate = await request('/api/accounting/transactions', json('POST', {
    kind: 'expense',
    description: 'تاريخ غير صالح',
    amount: 10,
    date: '2026-02-30'
  }, staff.token));
  assert.equal(invalidDate.status, 400);
  for (const [kind, description, amount] of [
    ['income', 'فاتورة عميل', 1200],
    ['purchase', '=SUM(1,2)', 50]
  ]) {
    const response = await request('/api/accounting/transactions', json('POST', {
      kind, description, amount, date: '2026-10-01'
    }, staff.token));
    assert.equal(response.status, 201);
  }
  const summary = await (await request('/api/accounting/summary?year=2026', {
    headers: authHeaders(staff.token)
  })).json();
  assert.equal(summary.income, 1200);
  assert.equal(summary.expenses, 50);
  const exportResponse = await request('/api/accounting/export.csv', { headers: authHeaders(staff.token) });
  assert.match(await exportResponse.text(), /"'=SUM\(1,2\)"/);

  const upload = new FormData();
  upload.append('category', 'مستندات');
  upload.append('file', new Blob(['test image content'], { type: 'image/png' }), 'test.png');
  const mediaResponse = await request('/api/media', {
    method: 'POST',
    headers: authHeaders(staff.token),
    body: upload
  });
  assert.equal(mediaResponse.status, 201);
  const media = await mediaResponse.json();
  assert.equal(media.original_name, 'test.png');
  const preview = await request(`/api/media/${media.id}/preview`, { headers: authHeaders(staff.token) });
  assert.equal(preview.status, 200);

  const rejectedUpload = new FormData();
  rejectedUpload.append('file', new Blob(['not an image'], { type: 'image/svg+xml' }), 'unsafe.svg');
  assert.equal((await request('/api/media', {
    method: 'POST',
    headers: authHeaders(staff.token),
    body: rejectedUpload
  })).status, 400);

  let limitedResponse;
  for (let i = 0; i < 300; i += 1) limitedResponse = await request('/api/health');
  assert.equal(limitedResponse.status, 429);
});

test('trusted proxy client IPs have independent login limits', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naib-proxy-'));
  const app = createApp({
    databasePath: path.join(dataDir, 'test.sqlite'),
    storagePath: path.join(dataDir, 'uploads'),
    tokenSecret: 'test-only-token-secret-long-enough',
    trustProxy: ['loopback']
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const credentials = { username: 'owner', password: 'very-long-test-password' };
  const registration = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials)
  });
  assert.equal(registration.status, 201);

  const failedLogin = () => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
    body: JSON.stringify({ ...credentials, password: 'incorrect-password' })
  });
  for (let i = 0; i < 10; i += 1) assert.equal((await failedLogin()).status, 401);
  assert.equal((await failedLogin()).status, 429);

  const otherClient = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.11' },
    body: JSON.stringify(credentials)
  });
  assert.equal(otherClient.status, 200);
});

test('daily backups retry media independently when its first copy fails', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naib-backup-'));
  const storagePath = path.join(dataDir, 'uploads');
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(storagePath);
  fs.writeFileSync(path.join(storagePath, 'document.txt'), 'saved file');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  let databaseBackups = 0;
  let uploadCopies = 0;
  const backup = createBackupRunner({
    db: {
      backup: async (filename) => {
        databaseBackups += 1;
        await fs.promises.writeFile(filename, 'database snapshot');
      }
    },
    storagePath,
    backupDir,
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    copyUploads: async (source, destination, options) => {
      uploadCopies += 1;
      if (uploadCopies === 1) {
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'partial.txt'), 'partial');
        throw new Error('simulated interrupted media copy');
      }
      await fs.promises.cp(source, destination, options);
    }
  });

  await assert.rejects(backup(), AggregateError);
  await backup();
  assert.equal(databaseBackups, 1);
  assert.equal(uploadCopies, 2);
  assert.equal(fs.readFileSync(path.join(backupDir, 'analyzer-2026-10-03.sqlite'), 'utf8'), 'database snapshot');
  assert.equal(fs.readFileSync(path.join(backupDir, 'uploads-2026-10-03', 'document.txt'), 'utf8'), 'saved file');
});
