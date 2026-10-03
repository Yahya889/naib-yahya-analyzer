const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createServer, analyzeContract } = require("../server");

async function startServer(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "naib-test-"));
  const server = createServer({ dataDir, uploadDir: path.join(dataDir, "uploads") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("contract review highlights absent clauses without claiming legal compliance", () => {
  const analysis = analyzeContract("يتفق الطرف الأول والطرف الثاني على نطاق العمل والدفع والمدة والإنهاء.");
  assert.equal(analysis.riskCount, 1);
  assert.match(analysis.findings[0].message, /القانون الواجب التطبيق/);
  assert.match(analysis.disclaimer, /ليس رأيًا قانونيًا/);
});

test("dashboard serves its Arabic RTL home page and rejects unknown static paths", async t => {
  const base = await startServer(t);
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("x-content-type-options"), "nosniff");
  assert.match(await home.text(), /lang="ar" dir="rtl"/);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
});

test("contract and finance APIs persist records and calculate summary totals", async t => {
  const base = await startServer(t);
  const contractResponse = await fetch(`${base}/api/contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "عقد خدمات", text: "نص أولي" })
  });
  assert.equal(contractResponse.status, 201);
  const contract = await contractResponse.json();
  assert.equal(contract.analysis.riskCount, 6);

  const addInvoice = (title, amount, kind) => fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, amount, kind, date: "2026-10-03" })
  });
  const [incomeResponse, expenseResponse] = await Promise.all([
    addInvoice("فاتورة", 1200, "income"),
    addInvoice("مشتريات", 200, "expense")
  ]);
  assert.equal(incomeResponse.status, 201);
  assert.equal(expenseResponse.status, 201);
  const summary = await (await fetch(`${base}/api/summary`)).json();
  assert.deepEqual(
    { contracts: summary.contracts, invoices: summary.invoices, income: summary.income, expenses: summary.expenses, balance: summary.balance },
    { contracts: 1, invoices: 2, income: 1200, expenses: 200, balance: 1000 }
  );
  assert.equal((await (await fetch(`${base}/api/invoices`)).json()).length, 2);
});

test("media API accepts valid PDFs and rejects files with a mismatched type", async t => {
  const base = await startServer(t);
  const form = new FormData();
  form.append("file", new Blob(["%PDF-1.4\nsample"], { type: "application/pdf" }), "report.pdf");
  const upload = await fetch(`${base}/api/files`, { method: "POST", body: form });
  assert.equal(upload.status, 201);
  const file = await upload.json();
  assert.equal(file.name, "report.pdf");
  const download = await fetch(`${base}/api/files/${file.id}`);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(await download.text(), /^%PDF-1\.4/);
  assert.equal((await fetch(`${base}/api/files/${file.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/files/${file.id}`)).status, 404);

  const invalid = new FormData();
  invalid.append("file", new Blob(["<script>alert(1)</script>"], { type: "text/html" }), "payload.html");
  assert.equal((await fetch(`${base}/api/files`, { method: "POST", body: invalid })).status, 400);
});

test("financial API rejects invalid amounts and calendar dates", async t => {
  const base = await startServer(t);
  const postInvoice = body => fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal((await postInvoice({ title: "حركة", amount: -1, kind: "income" })).status, 400);
  assert.equal((await postInvoice({ title: "حركة", amount: 1, kind: "income", date: "2026-13-40" })).status, 400);
});
