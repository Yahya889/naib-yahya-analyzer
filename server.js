const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_JSON_SIZE = 1024 * 1024;
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
const ALLOWED_FILES = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".txt", "text/plain"]
]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function analyzeContract(text) {
  const checks = [
    ["بيانات الأطراف", /الأطراف|الطرف الأول|الطرف الثاني|parties|party/i],
    ["نطاق العمل أو الالتزامات", /نطاق العمل|الالتزامات|الخدمات|scope|obligations/i],
    ["المقابل المالي وشروط الدفع", /المقابل المالي|الأجر|الدفع|الفاتورة|payment|fee/i],
    ["المدة وتاريخ الانتهاء", /المدة|تاريخ الانتهاء|ينتهي|term|expiration/i],
    ["الإنهاء وآثاره", /الإنهاء|فسخ|إنهاء العقد|termination/i],
    ["القانون الواجب التطبيق وتسوية النزاعات", /القانون الواجب التطبيق|الاختصاص|تسوية النزاعات|governing law|dispute/i]
  ];
  const findings = checks
    .filter(([, pattern]) => !pattern.test(text))
    .map(([name]) => ({ severity: "review", message: `تحقق من تضمين بند واضح حول: ${name}.` }));

  return {
    findings,
    riskCount: findings.length,
    disclaimer: "فحص أولي آلي لقائمة بنود عامة، وليس رأيًا قانونيًا أو تأكيدًا للامتثال للأنظمة السعودية. راجع العقد مع محامٍ مرخص."
  };
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("حجم الطلب أكبر من الحد المسموح.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const raw = await readBody(request, MAX_JSON_SIZE);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    const error = new Error("صيغة JSON غير صحيحة.");
    error.status = 400;
    throw error;
  }
}

function requiredText(value, field, maximum = 10000) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    const error = new Error(`الحقل ${field} مطلوب أو يتجاوز الحد المسموح.`);
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) {
    const error = new Error("طلب رفع الملف غير صالح.");
    error.status = 400;
    throw error;
  }

  const marker = Buffer.from(`--${boundary}`);
  let position = 0;
  let file;
  while ((position = buffer.indexOf(marker, position)) !== -1) {
    position += marker.length;
    if (buffer[position] === 45 && buffer[position + 1] === 45) break;
    if (buffer[position] === 13 && buffer[position + 1] === 10) position += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), position);
    if (headerEnd === -1) break;
    const headers = buffer.toString("utf8", position, headerEnd);
    const nextMarker = buffer.indexOf(Buffer.concat([Buffer.from("\r\n"), marker]), headerEnd + 4);
    if (nextMarker === -1) break;
    const disposition = /content-disposition:\s*form-data;[^\r\n]*filename="([^"]*)"/i.exec(headers);
    if (disposition) {
      file = {
        name: path.basename(disposition[1].replace(/\\/g, "/")),
        type: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1].trim().toLowerCase() || "application/octet-stream",
        data: buffer.subarray(headerEnd + 4, nextMarker)
      };
      break;
    }
    position = nextMarker + 2;
  }
  if (!file || !file.name) {
    const error = new Error("لم يتم العثور على ملف صالح.");
    error.status = 400;
    throw error;
  }
  return file;
}

function validateFile(file) {
  const extension = path.extname(file.name).toLowerCase();
  const expectedType = ALLOWED_FILES.get(extension);
  if (!expectedType || file.type !== expectedType || file.data.length === 0 || file.data.length > MAX_UPLOAD_SIZE) {
    const error = new Error("نوع الملف غير مدعوم أو حجمه يتجاوز 5 ميغابايت.");
    error.status = 400;
    throw error;
  }
  const validSignature =
    (extension === ".pdf" && file.data.subarray(0, 5).toString() === "%PDF-") ||
    (extension === ".png" && file.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    ([".jpg", ".jpeg"].includes(extension) && file.data[0] === 255 && file.data[1] === 216 && file.data[2] === 255) ||
    (extension === ".webp" && file.data.subarray(0, 4).toString() === "RIFF" && file.data.subarray(8, 12).toString() === "WEBP") ||
    (extension === ".txt" && !file.data.includes(0));
  if (!validSignature) {
    const error = new Error("محتوى الملف لا يطابق نوعه.");
    error.status = 400;
    throw error;
  }
  return { extension, mimeType: expectedType };
}

function createServer({ dataDir = path.join(ROOT, "data"), uploadDir = path.join(dataDir, "uploads") } = {}) {
  const databasePath = path.join(dataDir, "database.json");
  let databaseQueue = Promise.resolve();

  async function loadDatabase() {
    try {
      return JSON.parse(await fs.readFile(databasePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { contracts: [], invoices: [], files: [] };
    }
  }

  async function updateDatabase(update) {
    let result;
    const operation = databaseQueue.then(async () => {
      const database = await loadDatabase();
      result = await update(database);
      await fs.mkdir(dataDir, { recursive: true });
      const tempPath = `${databasePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(database, null, 2), { mode: 0o600 });
      await fs.rename(tempPath, databasePath);
    });
    databaseQueue = operation.catch(() => {});
    await operation;
    return result;
  }

  async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/summary") {
      const database = await loadDatabase();
      const income = database.invoices.filter(item => item.kind === "income").reduce((sum, item) => sum + item.amount, 0);
      const expenses = database.invoices.filter(item => item.kind === "expense").reduce((sum, item) => sum + item.amount, 0);
      return sendJson(response, 200, {
        contracts: database.contracts.length,
        invoices: database.invoices.length,
        files: database.files.length,
        income,
        expenses,
        balance: income - expenses
      });
    }

    if (request.method === "GET" && ["/api/contracts", "/api/invoices", "/api/files"].includes(url.pathname)) {
      const database = await loadDatabase();
      const key = url.pathname.slice("/api/".length);
      return sendJson(response, 200, database[key]);
    }

    if (request.method === "POST" && url.pathname === "/api/contracts") {
      const body = await readJson(request);
      const contract = {
        id: crypto.randomUUID(),
        title: requiredText(body.title, "العنوان", 160),
        text: requiredText(body.text, "نص العقد"),
        createdAt: new Date().toISOString(),
        analysis: analyzeContract(body.text)
      };
      await updateDatabase(database => database.contracts.unshift(contract));
      return sendJson(response, 201, contract);
    }

    if (request.method === "POST" && url.pathname === "/api/invoices") {
      const body = await readJson(request);
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 || !["income", "expense"].includes(body.kind)) {
        const error = new Error("أدخل مبلغًا موجبًا ونوع حركة صحيحًا.");
        error.status = 400;
        throw error;
      }
      const invoiceDate = body.date === undefined ? new Date().toISOString().slice(0, 10) : body.date;
      if (typeof invoiceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
        const error = new Error("التاريخ المدخل غير صالح.");
        error.status = 400;
        throw error;
      }
      const invoice = {
        id: crypto.randomUUID(),
        title: requiredText(body.title, "الوصف", 160),
        amount,
        kind: body.kind,
        date: invoiceDate,
        createdAt: new Date().toISOString()
      };
      const parsedDate = Date.parse(`${invoice.date}T00:00:00Z`);
      if (Number.isNaN(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== invoice.date) {
        const error = new Error("التاريخ المدخل غير صالح.");
        error.status = 400;
        throw error;
      }
      await updateDatabase(database => database.invoices.unshift(invoice));
      return sendJson(response, 201, invoice);
    }

    if (request.method === "POST" && url.pathname === "/api/files") {
      const contentType = request.headers["content-type"] || "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        const error = new Error("ارفع الملف بصيغة multipart/form-data.");
        error.status = 400;
        throw error;
      }
      const file = parseMultipart(await readBody(request, MAX_UPLOAD_SIZE + 64 * 1024), contentType);
      const { extension, mimeType } = validateFile(file);
      const id = crypto.randomUUID();
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(path.join(uploadDir, `${id}${extension}`), file.data, { flag: "wx", mode: 0o600 });
      const entry = {
        id,
        name: file.name.slice(0, 200),
        type: mimeType,
        size: file.data.length,
        createdAt: new Date().toISOString()
      };
      await updateDatabase(database => database.files.unshift(entry));
      return sendJson(response, 201, entry);
    }

    const fileMatch = /^\/api\/files\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (fileMatch && request.method === "GET") {
      const database = await loadDatabase();
      const entry = database.files.find(file => file.id === fileMatch[1]);
      if (!entry) return sendJson(response, 404, { error: "الملف غير موجود." });
      const extension = path.extname(entry.name).toLowerCase();
      const storedPath = path.join(uploadDir, `${entry.id}${extension}`);
      const content = await fs.readFile(storedPath);
      response.writeHead(200, {
        "Content-Type": entry.type,
        "Content-Length": content.length,
        "Content-Disposition": entry.type.startsWith("image/") ? "inline" : "attachment",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store"
      });
      return response.end(content);
    }

    const deleteMatch = /^\/api\/files\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (deleteMatch && request.method === "DELETE") {
      let deleted;
      await updateDatabase(async database => {
        const entry = database.files.find(file => file.id === deleteMatch[1]);
        if (!entry) return;
        database.files = database.files.filter(file => file.id !== entry.id);
        deleted = entry;
      });
      if (!deleted) return sendJson(response, 404, { error: "الملف غير موجود." });
      const entry = deleted;
      await fs.rm(path.join(uploadDir, `${entry.id}${path.extname(entry.name).toLowerCase()}`), { force: true });
      return sendJson(response, 200, { deleted: true });
    }

    return sendJson(response, 404, { error: "المسار غير موجود." });
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return sendJson(response, 405, { error: "الطريقة غير مدعومة." });
      }
      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!["index.html", "style.css", "app.js"].includes(requested)) {
        response.writeHead(404);
        return response.end("Not found");
      }
      const content = await fs.readFile(path.join(PUBLIC_DIR, requested));
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(requested)],
        "X-Content-Type-Options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (!error.status) console.error(error);
      sendJson(response, error.status || 500, { error: error.status ? error.message : "حدث خطأ داخلي." });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, process.env.HOST || "127.0.0.1", () => console.log(`Dashboard listening on http://127.0.0.1:${port}`));
}

module.exports = { createServer, analyzeContract };
