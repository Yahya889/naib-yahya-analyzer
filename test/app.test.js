const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
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
  assert.match(status.headers.get('content-security-policy'), /img-src 'self' data: blob:;/);
  assert.equal((await request('/api/documents')).status, 401);
  assert.equal((await request('/api/security/summary')).status, 401);

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

  const access = await request('/api/security/access', json('POST', {
    people: [
      { name: 'زائر أول', identityNumber: 'ID-101', phone: '0500000001' },
      { name: 'زائر ثان', identityNumber: 'ID-102', phone: '0500000002' }
    ],
    organization: 'شركة تجريبية',
    purpose: 'زيارة عمل',
    gate: 'البوابة الرئيسية',
    vehiclePlate: 'XYZ 987'
  }, staff.token));
  assert.equal(access.status, 201);
  const accessRecord = await access.json();
  assert.equal(accessRecord.person_count, 2);
  assert.match(accessRecord.vehicle_code, /^VH-[0-9A-F]{12}$/);
  const accessList = await (await request('/api/security/access?status=inside&search=ID-102', {
    headers: authHeaders(staff.token)
  })).json();
  assert.equal(accessList.length, 1);
  assert.equal(accessList[0].members.length, 2);
  const securitySummary = await (await request('/api/security/summary', {
    headers: authHeaders(staff.token)
  })).json();
  assert.equal(securitySummary.people_inside, 2);
  assert.equal(securitySummary.active_visits, 1);
  const exitResponse = await request(`/api/security/access/${accessRecord.id}/exit`, {
    method: 'POST',
    headers: authHeaders(staff.token)
  });
  assert.equal(exitResponse.status, 200);
  assert.ok((await exitResponse.json()).exited_at);
  assert.equal((await request(`/api/security/access/${accessRecord.id}/exit`, {
    method: 'POST',
    headers: authHeaders(staff.token)
  })).status, 409);

  const validUntil = new Date();
  validUntil.setUTCDate(validUntil.getUTCDate() + 7);
  const permitForm = new FormData();
  for (const [key, value] of Object.entries({
    permitNumber: 'VP-001',
    vehiclePlate: 'XYZ 987',
    driverName: 'سائق تجريبي',
    identityNumber: 'ID-201',
    phone: '0500000003',
    organization: 'شركة تجريبية',
    purpose: 'توريد',
    validFrom: '2020-01-01',
    validUntil: validUntil.toISOString().slice(0, 10)
  })) permitForm.append(key, value);
  permitForm.append('permitPhoto', new Blob(['test permit image'], { type: 'image/png' }), 'permit.png');
  const permitResponse = await request('/api/security/permits', {
    method: 'POST',
    headers: authHeaders(staff.token),
    body: permitForm
  });
  assert.equal(permitResponse.status, 201);
  const permit = await permitResponse.json();
  assert.equal(permit.vehicle_code, accessRecord.vehicle_code);
  const permitList = await (await request('/api/security/permits?status=expiring&search=XYZ', {
    headers: authHeaders(staff.token)
  })).json();
  assert.equal(permitList.length, 1);
  assert.equal(permitList[0].status, 'expiring');
  const vehicleLookup = await (await request(`/api/security/vehicles?plate=${encodeURIComponent('XYZ 987')}`, {
    headers: authHeaders(staff.token)
  })).json();
  assert.equal(vehicleLookup.vehicle_code, permit.vehicle_code);
  assert.equal(vehicleLookup.permits[0].driver_name, 'سائق تجريبي');
  assert.equal(vehicleLookup.access[0].members.length, 2);
  const codeLookup = await (await request(`/api/security/vehicles?plate=${encodeURIComponent(permit.vehicle_code)}`, {
    headers: authHeaders(staff.token)
  })).json();
  assert.equal(codeLookup.plate, 'XYZ 987');
  assert.equal((await (await request('/api/security/summary', {
    headers: authHeaders(staff.token)
  })).json()).expiring_permits, 1);
  const permitImage = await request(`/api/media/${permit.media_id}/preview`, { headers: authHeaders(staff.token) });
  assert.equal(permitImage.status, 200);
  assert.equal((await request(`/api/media/${permit.media_id}`, {
    method: 'DELETE',
    headers: authHeaders(staff.token)
  })).status, 409);

  const reportForm = new FormData();
  reportForm.append('title', 'ملاحظة عند البوابة');
  reportForm.append('category', 'ملاحظة');
  reportForm.append('location', 'البوابة الرئيسية');
  reportForm.append('details', 'تم توثيق الحالة بالصورة.');
  reportForm.append('reportPhoto', new Blob(['test report image'], { type: 'image/png' }), 'report.png');
  const reportResponse = await request('/api/security/reports', {
    method: 'POST',
    headers: authHeaders(staff.token),
    body: reportForm
  });
  assert.equal(reportResponse.status, 201);
  const report = await reportResponse.json();
  const reports = await (await request('/api/security/reports', {
    headers: authHeaders(staff.token)
  })).json();
  assert.equal(reports[0].title, 'ملاحظة عند البوابة');
  assert.equal((await request(`/api/media/${report.media_id}/preview`, {
    headers: authHeaders(staff.token)
  })).status, 200);

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

test('adds stable vehicle codes to data stored before the vehicle registry existed', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naib-vehicle-migration-'));
  const databasePath = path.join(dataDir, 'legacy.sqlite');
  const legacyDb = new Database(databasePath);
  legacyDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE media (
      id INTEGER PRIMARY KEY, filename TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL, size INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'عام',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE security_access (
      id INTEGER PRIMARY KEY, person_name TEXT NOT NULL, identity_number TEXT NOT NULL, phone TEXT NOT NULL,
      organization TEXT NOT NULL, purpose TEXT NOT NULL, gate TEXT NOT NULL,
      person_count INTEGER NOT NULL, vehicle_plate TEXT NOT NULL DEFAULT '',
      entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, exited_at TEXT, created_by INTEGER
    );
    CREATE TABLE vehicle_permits (
      id INTEGER PRIMARY KEY, permit_number TEXT NOT NULL UNIQUE, vehicle_plate TEXT NOT NULL,
      driver_name TEXT NOT NULL, identity_number TEXT NOT NULL, phone TEXT NOT NULL,
      organization TEXT NOT NULL, purpose TEXT NOT NULL, valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL, media_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER
    );
    INSERT INTO security_access
      (person_name, identity_number, phone, organization, purpose, gate, person_count, vehicle_plate)
    VALUES ('زائر', 'ID-1', '0500000000', '', 'زيارة', 'الرئيسية', 1, 'xyz 987');
    INSERT INTO media (filename, original_name, mime_type, size) VALUES ('old.png', 'old.png', 'image/png', 1);
    INSERT INTO vehicle_permits
      (permit_number, vehicle_plate, driver_name, identity_number, phone, organization,
        purpose, valid_from, valid_until, media_id)
    VALUES ('OLD-1', 'XYZ 987', 'سائق', 'ID-2', '0500000001', '', 'دخول', '2020-01-01', '2030-01-01', 1);
  `);
  legacyDb.close();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const app = createApp({
    databasePath,
    storagePath: path.join(dataDir, 'uploads'),
    tokenSecret: 'test-only-token-secret-long-enough'
  });
  const vehicles = app.locals.db.prepare(`
    SELECT DISTINCT vehicle_code FROM (
      SELECT v.vehicle_code FROM security_access a JOIN vehicles v ON v.id = a.vehicle_id
      UNION ALL
      SELECT v.vehicle_code FROM vehicle_permits p JOIN vehicles v ON v.id = p.vehicle_id
    )
  `).all();
  assert.equal(vehicles.length, 1);
  assert.match(vehicles[0].vehicle_code, /^VH-[0-9A-F]{12}$/);
  app.locals.close();
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
