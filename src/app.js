const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_PERMIT_PHOTO_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = {
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword', 'application/octet-stream'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'],
  '.xls': ['application/vnd.ms-excel', 'application/octet-stream'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png']
};
const LEGAL_CLAUSES = [
  { key: 'الأطراف', pattern: /الأطراف|الطرف الأول|الطرف الثاني|المتعاقد|parties|first party/i },
  { key: 'نطاق العمل والالتزامات', pattern: /الالتزامات|نطاق العمل|الخدمات|المهام|obligations|scope of work/i },
  { key: 'المقابل وآلية الدفع', pattern: /المبلغ|المقابل|ريال|الدفع|الأجرة|payment|fee|amount|sar/i },
  { key: 'المدة والتواريخ', pattern: /المدة|تاريخ|سنة|شهر|يوم|ينتهي|term|duration|date/i },
  { key: 'الإنهاء والفسخ', pattern: /الإنهاء|إنهاء|فسخ|إلغاء|termination|cancel/i },
  { key: 'حل النزاعات والاختصاص', pattern: /نزاع|النزاعات|المحكمة|الاختصاص|التحكيم|dispute|jurisdiction/i },
  { key: 'التوقيع', pattern: /التوقيع|توقيع|التواقيع|signature|signed/i }
];

function createApp(options = {}) {
  const dataDir = options.dataDir || path.resolve(process.env.DATA_DIR || 'data');
  const databasePath = options.databasePath || path.join(dataDir, 'analyzer.sqlite');
  const storagePath = options.storagePath || path.join(dataDir, 'uploads');
  const isMemoryDatabase = databasePath === ':memory:';
  if (!isMemoryDatabase) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  fs.mkdirSync(storagePath, { recursive: true });

  const tokenSecret = options.tokenSecret || process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(tokenSecret) < 32) {
    throw new Error('TOKEN_SECRET must contain at least 32 bytes in production.');
  }

  function requireAdmin(req, res, next) {
    if (req.role !== 'admin') return res.status(403).json({ error: 'هذه العملية متاحة لمسؤول النظام فقط.' });
    next();
  }

  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  if (!isMemoryDatabase) db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'purchase')),
      description TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL DEFAULT 'SAR',
      transaction_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'عام',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS security_access (
      id INTEGER PRIMARY KEY,
      person_name TEXT NOT NULL,
      identity_number TEXT NOT NULL,
      phone TEXT NOT NULL,
      organization TEXT NOT NULL,
      purpose TEXT NOT NULL,
      gate TEXT NOT NULL,
      person_count INTEGER NOT NULL CHECK (person_count > 0),
      vehicle_plate TEXT NOT NULL DEFAULT '',
      entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      exited_at TEXT,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS security_access_members (
      id INTEGER PRIMARY KEY,
      access_id INTEGER NOT NULL REFERENCES security_access(id) ON DELETE CASCADE,
      person_name TEXT NOT NULL,
      identity_number TEXT NOT NULL,
      phone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vehicle_permits (
      id INTEGER PRIMARY KEY,
      permit_number TEXT NOT NULL UNIQUE,
      vehicle_plate TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      identity_number TEXT NOT NULL,
      phone TEXT NOT NULL,
      organization TEXT NOT NULL,
      purpose TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      media_id INTEGER NOT NULL REFERENCES media(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS security_access_status_idx ON security_access(exited_at, id DESC);
    CREATE INDEX IF NOT EXISTS vehicle_permits_expiry_idx ON vehicle_permits(valid_until);
  `);

  const app = express();
  app.disable('x-powered-by');
  const trustedProxies = options.trustProxy ?? process.env.TRUST_PROXY;
  if (trustedProxies) {
    const proxies = (Array.isArray(trustedProxies) ? trustedProxies : String(trustedProxies).split(','))
      .map((proxy) => proxy.trim())
      .filter(Boolean);
    if (!proxies.length) throw new Error('TRUST_PROXY must list the trusted proxy IPs or CIDRs.');
    app.set('trust proxy', proxies);
  }
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        imgSrc: ["'self'", 'data:', 'blob:']
      }
    }
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'طلبات كثيرة. حاول بعد دقيقة.' }
  }));

  function audit(action, details = {}) {
    db.prepare('INSERT INTO audit_log (action, details) VALUES (?, ?)').run(action, JSON.stringify(details));
  }

  function makeToken(userId) {
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
    const signature = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function requireAuth(req, res, next) {
    const authorization = req.get('authorization') || '';
    const token = authorization.slice(0, 7).toLowerCase() === 'bearer '
      ? authorization.slice(7).trim()
      : '';
    if (token.length > 2048) return res.status(401).json({ error: 'رمز الدخول غير صالح.' });
    if (!token) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' });
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return res.status(401).json({ error: 'رمز الدخول غير صالح.' });
    const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest();
    let actual;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return res.status(401).json({ error: 'رمز الدخول غير صالح.' });
    }
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: 'رمز الدخول غير صالح.' });
    }
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (!Number.isInteger(decoded.sub) || decoded.exp < Date.now()) {
        return res.status(401).json({ error: 'انتهت صلاحية تسجيل الدخول.' });
      }
      const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(decoded.sub);
      if (!user) return res.status(401).json({ error: 'الحساب غير موجود.' });
      req.userId = user.id;
      req.role = user.role;
      next();
    } catch {
      return res.status(401).json({ error: 'رمز الدخول غير صالح.' });
    }
  }

  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'محاولات كثيرة. حاول بعد 15 دقيقة.' }
  });

  app.get('/api/auth/status', (_req, res) => {
    res.json({ configured: db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0 });
  });

  app.post('/api/auth/register', authRateLimit, (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[\p{L}\p{N}_.-]{3,40}$/u.test(username.trim())) {
      return res.status(400).json({ error: 'اسم المستخدم يجب أن يتكون من 3 إلى 40 حرفاً أو رقماً.' });
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تتكون من 12 حرفاً على الأقل.' });
    }
    if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) {
      return res.status(403).json({ error: 'تم إعداد الحساب الأول مسبقاً. تواصل مع مسؤول النظام لإضافة مستخدم.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const result = db.prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
      .run(username.trim(), passwordHash, salt, 'admin');
    audit('إنشاء الحساب الأول', { userId: result.lastInsertRowid });
    res.status(201).json({ token: makeToken(result.lastInsertRowid), username: username.trim() });
  });

  app.post('/api/auth/login', authRateLimit, (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور.' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    const salt = user?.salt || crypto.randomBytes(16).toString('hex');
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
    if (!user || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    }
    res.json({ token: makeToken(user.id), username: user.username });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود.' });
    res.json(user);
  });

  app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
    res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all());
  });

  app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role = 'staff' } = req.body || {};
    if (typeof username !== 'string' || !/^[\p{L}\p{N}_.-]{3,40}$/u.test(username.trim()) ||
        typeof password !== 'string' || password.length < 12 || password.length > 128 ||
        !['admin', 'staff'].includes(role)) {
      return res.status(400).json({ error: 'تحقق من اسم المستخدم وكلمة المرور والصلاحية.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    try {
      const result = db.prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
        .run(username.trim(), passwordHash, salt, role);
      audit('إنشاء مستخدم', { userId: result.lastInsertRowid, role });
      res.status(201).json(db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'اسم المستخدم مستخدم مسبقاً.' });
      throw error;
    }
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/api/security/summary', requireAuth, (_req, res) => {
    const access = db.prepare(`
      SELECT COALESCE(SUM(person_count), 0) AS people_inside,
        COUNT(*) AS active_visits
      FROM security_access WHERE exited_at IS NULL
    `).get();
    const permits = db.prepare(`
      SELECT
        SUM(CASE WHEN valid_until < date('now') THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN valid_from <= date('now') AND valid_until >= date('now')
          AND valid_until <= date('now', '+30 days') THEN 1 ELSE 0 END) AS expiring
      FROM vehicle_permits
    `).get();
    res.json({
      people_inside: access.people_inside,
      active_visits: access.active_visits,
      expired_permits: permits.expired || 0,
      expiring_permits: permits.expiring || 0
    });
  });

  app.get('/api/security/access', requireAuth, (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const status = req.query.status || 'all';
    if (!['all', 'inside', 'exited'].includes(status)) {
      return res.status(400).json({ error: 'حالة سجل الدخول غير صالحة.' });
    }
    const records = db.prepare(`
      SELECT id, person_name, identity_number, phone, organization, purpose, gate,
        person_count, vehicle_plate, entered_at, exited_at
      FROM security_access
      WHERE (? = 'all' OR (? = 'inside' AND exited_at IS NULL) OR (? = 'exited' AND exited_at IS NOT NULL))
        AND (? = '' OR person_name LIKE ? OR identity_number LIKE ? OR phone LIKE ?
          OR organization LIKE ? OR vehicle_plate LIKE ? OR EXISTS (
            SELECT 1 FROM security_access_members member
            WHERE member.access_id = security_access.id
              AND (member.person_name LIKE ? OR member.identity_number LIKE ? OR member.phone LIKE ?)
          ))
      ORDER BY id DESC LIMIT 200
    `).all(
      status, status, status, search,
      `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`,
      `%${search}%`, `%${search}%`, `%${search}%`
    );
    if (!records.length) return res.json(records);
    const placeholders = records.map(() => '?').join(',');
    const members = db.prepare(`
      SELECT access_id, person_name, identity_number, phone
      FROM security_access_members WHERE access_id IN (${placeholders}) ORDER BY id
    `).all(...records.map((record) => record.id));
    const membersByAccess = new Map();
    members.forEach((member) => {
      const list = membersByAccess.get(member.access_id) || [];
      list.push({ name: member.person_name, identity_number: member.identity_number, phone: member.phone });
      membersByAccess.set(member.access_id, list);
    });
    res.json(records.map((record) => ({ ...record, members: membersByAccess.get(record.id) || [] })));
  });

  app.post('/api/security/access', requireAuth, (req, res) => {
    const {
      people, organization = '', purpose, gate, vehiclePlate = ''
    } = req.body || {};
    const requiredText = (value, max) =>
      typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
    if (!Array.isArray(people) || people.length < 1 || people.length > 200 ||
        people.some((person) => !person || !requiredText(person.name, 120) ||
          !requiredText(person.identityNumber, 40) || !requiredText(person.phone, 30)) ||
        typeof organization !== 'string' || organization.trim().length > 120 ||
        !requiredText(purpose, 200) || !requiredText(gate, 80) ||
        typeof vehiclePlate !== 'string' || vehiclePlate.trim().length > 30) {
      return res.status(400).json({ error: 'أدخل بيانات كل شخص (الاسم والهوية والهاتف) وتحقق من الجهة والغرض والبوابة.' });
    }
    const record = db.transaction(() => {
      const firstPerson = people[0];
      const result = db.prepare(`
        INSERT INTO security_access
          (person_name, identity_number, phone, organization, purpose, gate, person_count, vehicle_plate, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        firstPerson.name.trim(), firstPerson.identityNumber.trim(), firstPerson.phone.trim(),
        organization.trim(), purpose.trim(), gate.trim(), people.length, vehiclePlate.trim(), req.userId
      );
      const addMember = db.prepare(`
        INSERT INTO security_access_members (access_id, person_name, identity_number, phone)
        VALUES (?, ?, ?, ?)
      `);
      people.forEach((person) => addMember.run(
        result.lastInsertRowid, person.name.trim(), person.identityNumber.trim(), person.phone.trim()
      ));
      audit('تسجيل دخول للموقع', { accessId: result.lastInsertRowid, personCount: people.length });
      return db.prepare('SELECT * FROM security_access WHERE id = ?').get(result.lastInsertRowid);
    })();
    record.members = people.map((person) => ({
      name: person.name.trim(),
      identity_number: person.identityNumber.trim(),
      phone: person.phone.trim()
    }));
    res.status(201).json(record);
  });

  app.post('/api/security/access/:id/exit', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'رقم السجل غير صالح.' });
    const record = db.prepare('SELECT id, exited_at FROM security_access WHERE id = ?').get(id);
    if (!record) return res.status(404).json({ error: 'سجل الدخول غير موجود.' });
    if (record.exited_at) return res.status(409).json({ error: 'تم تسجيل خروج هذا السجل مسبقاً.' });
    db.prepare('UPDATE security_access SET exited_at = CURRENT_TIMESTAMP WHERE id = ? AND exited_at IS NULL').run(id);
    audit('تسجيل خروج من الموقع', { accessId: id });
    res.json(db.prepare('SELECT * FROM security_access WHERE id = ?').get(id));
  });

  const permitPhotoUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, storagePath),
      filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: MAX_PERMIT_PHOTO_SIZE, files: 1 },
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (!['.jpg', '.jpeg', '.png'].includes(extension) ||
          !ALLOWED_TYPES[extension]?.includes(file.mimetype)) {
        return callback(new Error('صورة التصريح يجب أن تكون JPG أو PNG.'));
      }
      callback(null, true);
    }
  });

  app.get('/api/security/permits', requireAuth, (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const status = req.query.status || 'all';
    if (!['all', 'active', 'upcoming', 'expiring', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'حالة التصريح غير صالحة.' });
    }
    const permits = db.prepare(`
      SELECT p.id, p.permit_number, p.vehicle_plate, p.driver_name, p.identity_number,
        p.phone, p.organization, p.purpose, p.valid_from, p.valid_until, p.media_id, p.created_at,
        CASE WHEN p.valid_from > date('now') THEN 'upcoming'
          WHEN p.valid_until < date('now') THEN 'expired'
          WHEN p.valid_until <= date('now', '+30 days') THEN 'expiring'
          ELSE 'active' END AS status
      FROM vehicle_permits p
      WHERE (? = 'all'
        OR (? = 'expired' AND p.valid_until < date('now'))
        OR (? = 'expiring' AND p.valid_from <= date('now') AND p.valid_until >= date('now') AND p.valid_until <= date('now', '+30 days'))
        OR (? = 'active' AND p.valid_from <= date('now') AND p.valid_until > date('now', '+30 days'))
        OR (? = 'upcoming' AND p.valid_from > date('now')))
        AND (? = '' OR p.permit_number LIKE ? OR p.vehicle_plate LIKE ?
          OR p.driver_name LIKE ? OR p.identity_number LIKE ? OR p.organization LIKE ?)
      ORDER BY p.valid_until ASC, p.id DESC LIMIT 500
    `).all(status, status, status, status, status, search, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    res.json(permits);
  });

  app.post('/api/security/permits', requireAuth, permitPhotoUpload.single('permitPhoto'), (req, res) => {
    const photoPath = req.file ? path.join(storagePath, req.file.filename) : null;
    const {
      permitNumber, vehiclePlate, driverName, identityNumber, phone,
      organization = '', purpose, validFrom, validUntil
    } = req.body || {};
    const requiredText = (value, max) =>
      typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
    const validDate = (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    const invalid = !req.file || !requiredText(permitNumber, 80) || !requiredText(vehiclePlate, 30) ||
      !requiredText(driverName, 120) || !requiredText(identityNumber, 40) ||
      !requiredText(phone, 30) || typeof organization !== 'string' || organization.trim().length > 120 ||
      !requiredText(purpose, 200) || !validDate(validFrom) || !validDate(validUntil) ||
      validUntil < validFrom;
    if (invalid) {
      if (photoPath) fs.rmSync(photoPath, { force: true });
      return res.status(400).json({ error: 'أكمل بيانات التصريح وتأكد من صحة فترة الصلاحية وإرفاق صورة JPG أو PNG.' });
    }

    try {
      const createPermit = db.transaction(() => {
        const mediaResult = db.prepare(`
          INSERT INTO media (filename, original_name, mime_type, size, category)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          req.file.filename,
          path.basename(req.file.originalname.replaceAll('\\', '/')).slice(0, 255),
          req.file.mimetype,
          req.file.size,
          'تصاريح المركبات'
        );
        const permitResult = db.prepare(`
          INSERT INTO vehicle_permits
            (permit_number, vehicle_plate, driver_name, identity_number, phone, organization,
              purpose, valid_from, valid_until, media_id, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          permitNumber.trim(), vehiclePlate.trim(), driverName.trim(), identityNumber.trim(),
          phone.trim(), organization.trim(), purpose.trim(), validFrom, validUntil,
          mediaResult.lastInsertRowid, req.userId
        );
        audit('إضافة تصريح مركبة', { permitId: permitResult.lastInsertRowid });
        return db.prepare(`
          SELECT id, permit_number, vehicle_plate, driver_name, identity_number, phone,
            organization, purpose, valid_from, valid_until, media_id, created_at
          FROM vehicle_permits WHERE id = ?
        `).get(permitResult.lastInsertRowid);
      });
      res.status(201).json(createPermit());
    } catch (error) {
      if (photoPath) fs.rmSync(photoPath, { force: true });
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'رقم التصريح مسجل مسبقاً.' });
      }
      throw error;
    }
  });

  app.get('/api/documents', requireAuth, (_req, res) => {
    const documents = db.prepare('SELECT id, title, analysis_json, created_at FROM documents ORDER BY id DESC').all()
      .map((document) => ({ ...document, analysis: JSON.parse(document.analysis_json) }));
    res.json(documents);
  });

  app.post('/api/documents/analyze', requireAuth, (req, res) => {
    const { title, content } = req.body || {};
    if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
        typeof content !== 'string' || !content.trim() || content.length > 1_000_000) {
      return res.status(400).json({ error: 'أدخل عنواناً ونصاً للمستند (بحد أقصى مليون حرف).' });
    }
    const clauses = LEGAL_CLAUSES.map(({ key, pattern }) => ({ name: key, present: pattern.test(content) }));
    const presentCount = clauses.filter((clause) => clause.present).length;
    const analysis = {
      score: Math.round((presentCount / clauses.length) * 100),
      clauses,
      risks: clauses.filter((clause) => !clause.present).map((clause) => `لم يتم العثور على بند واضح: ${clause.name}`),
      disclaimer: 'فحص أولي للكلمات والبنود الظاهرة فقط؛ لا يمثل استشارة قانونية أو حكماً بالامتثال للأنظمة السعودية. راجع محامياً مرخصاً.'
    };
    const result = db.prepare('INSERT INTO documents (title, content, analysis_json) VALUES (?, ?, ?)')
      .run(title.trim(), content, JSON.stringify(analysis));
    audit('تحليل مستند', { documentId: result.lastInsertRowid });
    res.status(201).json({ id: result.lastInsertRowid, title: title.trim(), content, analysis });
  });

  app.get('/api/documents/:id', requireAuth, (req, res) => {
    const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!document) return res.status(404).json({ error: 'المستند غير موجود.' });
    res.json({ ...document, analysis: JSON.parse(document.analysis_json) });
  });

  app.delete('/api/documents/:id', requireAuth, (req, res) => {
    const result = db.prepare('DELETE FROM documents WHERE id = ?').run(Number(req.params.id));
    if (!result.changes) return res.status(404).json({ error: 'المستند غير موجود.' });
    audit('حذف مستند', { documentId: Number(req.params.id) });
    res.status(204).end();
  });

  app.get('/api/accounting/transactions', requireAuth, (req, res) => {
    const { kind, search } = req.query;
    if (kind && !['income', 'expense', 'purchase'].includes(kind)) {
      return res.status(400).json({ error: 'نوع الحركة غير صالح.' });
    }
    const transactions = db.prepare(`
      SELECT * FROM transactions
      WHERE (? = '' OR kind = ?)
        AND (? = '' OR description LIKE ?)
      ORDER BY transaction_date DESC, id DESC
    `).all(kind || '', kind || '', search || '', `%${search || ''}%`);
    res.json(transactions);
  });

  app.post('/api/accounting/transactions', requireAuth, (req, res) => {
    const { kind, description, amount, currency = 'SAR', date } = req.body || {};
    const parsedDate = typeof date === 'string' ? new Date(`${date}T00:00:00.000Z`) : null;
    if (!['income', 'expense', 'purchase'].includes(kind) ||
        typeof description !== 'string' || !description.trim() || description.length > 200 ||
        !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 ||
        typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ||
        typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(parsedDate?.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ error: 'تحقق من نوع الحركة والوصف والمبلغ والعملة والتاريخ.' });
    }
    const result = db.prepare(`
      INSERT INTO transactions (kind, description, amount, currency, transaction_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(kind, description.trim(), Math.round(amount * 100) / 100, currency, date);
    const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
    audit('إضافة حركة مالية', { transactionId: transaction.id, kind, amount: transaction.amount });
    res.status(201).json(transaction);
  });

  app.delete('/api/accounting/transactions/:id', requireAuth, (req, res) => {
    const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(Number(req.params.id));
    if (!result.changes) return res.status(404).json({ error: 'الحركة غير موجودة.' });
    audit('حذف حركة مالية', { transactionId: Number(req.params.id) });
    res.status(204).end();
  });

  app.get('/api/accounting/summary', requireAuth, (req, res) => {
    const year = req.query.year || String(new Date().getFullYear());
    if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'السنة غير صالحة.' });
    const monthly = db.prepare(`
      SELECT substr(transaction_date, 6, 2) AS month,
        SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN kind != 'income' THEN amount ELSE 0 END) AS expenses
      FROM transactions WHERE substr(transaction_date, 1, 4) = ? AND currency = 'SAR'
      GROUP BY month ORDER BY month
    `).all(year);
    const totals = monthly.reduce((result, row) => {
      result.income += row.income || 0;
      result.expenses += row.expenses || 0;
      return result;
    }, { income: 0, expenses: 0 });
    res.json({
      year: Number(year),
      currency: 'SAR',
      income: totals.income,
      expenses: totals.expenses,
      balance: totals.income - totals.expenses,
      monthly: Array.from({ length: 12 }, (_, i) => {
        const month = String(i + 1).padStart(2, '0');
        return monthly.find((row) => row.month === month) || { month, income: 0, expenses: 0 };
      })
    });
  });

  app.get('/api/accounting/export.csv', requireAuth, (_req, res) => {
    const rows = db.prepare('SELECT transaction_date, kind, description, amount, currency FROM transactions ORDER BY transaction_date DESC').all();
    const csvCell = (value) => {
      let safeValue = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(safeValue)) safeValue = `'${safeValue}`;
      return `"${safeValue.replaceAll('"', '""')}"`;
    };
    const csv = ['التاريخ,النوع,الوصف,المبلغ,العملة', ...rows.map((row) =>
      [row.transaction_date, row.kind, row.description, row.amount, row.currency].map(csvCell).join(',')
    )].join('\r\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="transactions.csv"' });
    res.send(`\uFEFF${csv}`);
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, storagePath),
      filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_TYPES[extension]?.includes(file.mimetype)) {
        return callback(new Error('نوع الملف غير مدعوم أو لا يطابق امتداده.'));
      }
      callback(null, true);
    }
  });

  app.get('/api/media', requireAuth, (_req, res) => {
    res.json(db.prepare('SELECT id, original_name, mime_type, size, category, created_at FROM media ORDER BY id DESC').all());
  });

  app.post('/api/media', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'اختر ملفاً للرفع.' });
    const originalName = path.basename(req.file.originalname.replaceAll('\\', '/')).slice(0, 255);
    const category = typeof req.body.category === 'string' ? req.body.category.trim().slice(0, 80) || 'عام' : 'عام';
    const result = db.prepare(`
      INSERT INTO media (filename, original_name, mime_type, size, category)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.file.filename, originalName, req.file.mimetype, req.file.size, category);
    audit('رفع ملف', { mediaId: result.lastInsertRowid });
    res.status(201).json(db.prepare('SELECT id, original_name, mime_type, size, category, created_at FROM media WHERE id = ?').get(result.lastInsertRowid));
  });

  app.get('/api/media/:id/preview', requireAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
    if (!file) return res.status(404).json({ error: 'الملف غير موجود.' });
    if (!file.mime_type.startsWith('image/')) return res.status(415).json({ error: 'المعاينة متاحة للصور فقط.' });
    res.type(file.mime_type).sendFile(path.join(storagePath, file.filename));
  });

  app.get('/api/media/:id', requireAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
    if (!file) return res.status(404).json({ error: 'الملف غير موجود.' });
    res.download(path.join(storagePath, file.filename), file.original_name);
  });

  app.delete('/api/media/:id', requireAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
    if (!file) return res.status(404).json({ error: 'الملف غير موجود.' });
    if (db.prepare('SELECT 1 FROM vehicle_permits WHERE media_id = ?').get(file.id)) {
      return res.status(409).json({ error: 'لا يمكن حذف صورة مرتبطة بتصريح مركبة.' });
    }
    db.prepare('DELETE FROM media WHERE id = ?').run(file.id);
    fs.rmSync(path.join(storagePath, file.filename), { force: true });
    audit('حذف ملف', { mediaId: file.id });
    res.status(204).end();
  });

  app.get('/api/audit', requireAuth, (_req, res) => {
    res.json(db.prepare('SELECT id, action, details, created_at FROM audit_log ORDER BY id DESC LIMIT 100').all());
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'المسار غير موجود.' }));
  app.use(express.static(path.resolve(__dirname, '../public')));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const maxSize = error.field === 'permitPhoto' ? '10 ميجابايت' : '100 ميجابايت';
      const message = error.code === 'LIMIT_FILE_SIZE' ? `حجم الملف يتجاوز الحد الأقصى (${maxSize}).` : 'تعذر رفع الملف.';
      return res.status(400).json({ error: message });
    }
    if (['نوع الملف غير مدعوم أو لا يطابق امتداده.', 'صورة التصريح يجب أن تكون JPG أو PNG.'].includes(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'حدث خطأ داخلي.' });
  });
  app.locals.db = db;
  app.locals.storagePath = storagePath;
  app.locals.close = () => db.close();
  return app;
}

module.exports = { createApp, MAX_FILE_SIZE };
