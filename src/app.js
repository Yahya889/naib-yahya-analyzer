const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');

const MAX_FILE_SIZE = 100 * 1024 * 1024;
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
  `);

  const app = express();
  app.disable('x-powered-by');
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

  const loginAttempts = new Map();
  const authRateLimit = (req, res, next) => {
    const now = Date.now();
    const attempts = loginAttempts.get(req.ip) || { count: 0, start: now };
    if (now - attempts.start > 15 * 60 * 1000) {
      attempts.count = 0;
      attempts.start = now;
    }
    if (attempts.count >= 10) return res.status(429).json({ error: 'محاولات كثيرة. حاول بعد 15 دقيقة.' });
    attempts.count += 1;
    loginAttempts.set(req.ip, attempts);
    next();
  };

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
    loginAttempts.delete(req.ip);
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
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف يتجاوز الحد الأقصى (100 ميجابايت).' : 'تعذر رفع الملف.';
      return res.status(400).json({ error: message });
    }
    if (error.message === 'نوع الملف غير مدعوم أو لا يطابق امتداده.') {
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
