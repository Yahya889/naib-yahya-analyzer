'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4173;
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_SIZE = 32 * 1024;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  res.end(contentType.startsWith('application/json') ? JSON.stringify(payload) : payload);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
      const error = new Error('الطلب كبير جداً.');
      error.status = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('صيغة الطلب غير صالحة.');
    error.status = 400;
    throw error;
  }
}

function createServer({ fetchImpl = fetch, ollamaUrl = OLLAMA_URL, model = MODEL } = {}) {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${HOST}`);

    if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
      return send(res, 200, { ok: true, model });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/chat') {
      try {
        const body = await readJson(req);
        if (typeof body.task !== 'string' || !body.task.trim() || body.task.length > 12000 ||
            typeof body.domain !== 'string' || body.domain.length > 80 ||
            typeof body.phase !== 'string' || !['plan', 'execute'].includes(body.phase) ||
            (body.phase === 'execute' && (typeof body.plan !== 'string' || body.plan.length > 12000))) {
          return send(res, 400, { error: 'أدخل طلباً صالحاً ومختصراً واختر مرحلة العمل.' });
        }

        const prompt = body.phase === 'plan'
          ? `المجال: ${body.domain}\nالمهمة: ${body.task}\n\nاقترح خطة قصيرة من 3 إلى 6 خطوات قابلة للتنفيذ. لا تدّعِ أنك بحثت في الإنترنت أو فتحت ملفات أو نفذت إجراءات. اذكر أي معلومات ناقصة أو مخاطر، واكتب بالعربية الواضحة.`
          : `المجال: ${body.domain}\nالمهمة: ${body.task}\nالخطة التي وافق عليها المستخدم: ${body.plan}\n\nنفّذ فكرياً ما يمكن تقديمه كنص أو مسودة داخل المحادثة، واكتب النتيجة بالعربية. لا تدّعِ تنفيذ بحث بالإنترنت أو التعامل مع ملفات لم يرفعها المستخدم كنص. لا تنفذ أو تدّعِ تنفيذ أي إجراء خارجي؛ نبّه المستخدم للمراجعة والتحقق.`;

        let upstream;
        try {
          upstream = await fetchImpl(ollamaUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              stream: false,
              messages: [
                {
                  role: 'system',
                  content: 'أنت مساعد إنتاجية عربي. كن مباشراً ومنظماً، ميّز بين الحقائق والافتراضات، ولا تختلق مصادر أو إجراءات تمت.'
                },
                { role: 'user', content: prompt }
              ],
              options: { temperature: 0.3 }
            }),
            signal: AbortSignal.timeout(120000)
          });
        } catch {
          return send(res, 503, { error: 'تعذر الاتصال بـ Ollama المحلي. شغّله وتأكد من تنزيل النموذج.' });
        }

        if (!upstream.ok) return send(res, 502, { error: 'تعذر على Ollama إكمال الطلب. تحقق من اسم النموذج.' });
        const result = await upstream.json();
        const answer = result?.message?.content;
        if (typeof answer !== 'string' || !answer.trim()) {
          return send(res, 502, { error: 'أعاد النموذج استجابة غير صالحة.' });
        }
        return send(res, 200, { answer });
      } catch (error) {
        return send(res, error.status || 400, { error: error.status ? error.message : 'تعذر إكمال الطلب.' });
      }
    }

    if (req.method !== 'GET' || requestUrl.pathname.startsWith('/api/')) {
      return send(res, 404, { error: 'المسار غير موجود.' });
    }

    const fileName = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.slice(1);
    if (!['index.html', 'app.js', 'styles.css'].includes(fileName)) {
      return send(res, 404, { error: 'الصفحة غير موجودة.' });
    }
    const filePath = path.join(PUBLIC_DIR, fileName);
    try {
      const content = await fs.promises.readFile(filePath);
      return send(res, 200, content, MIME_TYPES[path.extname(fileName)]);
    } catch {
      return send(res, 500, { error: 'تعذر تحميل واجهة التطبيق.' });
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Arabic AI Studio listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { createServer };
