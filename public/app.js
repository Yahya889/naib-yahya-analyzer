const formatMoney = value => new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR", maximumFractionDigits: 2 }).format(value || 0);
const formatDate = value => new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium" }).format(new Date(`${value.slice(0, 10)}T00:00:00`));
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
let contracts = [];
let invoices = [];
let files = [];
let auditLog = [];
let currentContract = null;
let previewUrl = null;
const contractScore = contract => Number.isFinite(contract.analysis.score)
  ? contract.analysis.score
  : Math.round((6 - contract.analysis.riskCount) / 6 * 100);

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || "تعذر تنفيذ الطلب.");
  return data;
}

function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3000);
}

function showView(name) {
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === name));
  document.querySelectorAll(".nav-link").forEach(link => link.classList.toggle("active", link.dataset.view === name));
  document.getElementById("page-title").textContent = ({ overview: "نظرة عامة", contracts: "تحليل العقود", finance: "المحاسبة المالية", media: "إدارة الوسائط" })[name] || "نظرة عامة";
  location.hash = name;
}

function renderTable(target, items) {
  const body = document.getElementById(target);
  if (!items.length) {
    body.innerHTML = '<tr><td class="no-data" colspan="4">لا توجد حركات مالية مسجلة بعد.</td></tr>';
    return;
  }
  body.innerHTML = items.map(item => `<tr><td>${escapeHtml(item.title)}</td><td>${formatDate(item.date || item.createdAt)}</td><td><span class="badge ${item.kind === "expense" ? "expense" : ""}">${item.kind === "expense" ? "مصروف" : "إيراد"}</span></td><td class="${item.kind === "expense" ? "amount-expense" : "amount-income"}">${item.kind === "expense" ? "−" : "+"}${formatMoney(item.amount)}</td></tr>`).join("");
}

function renderChart(target, income, expenses) {
  const max = Math.max(income, expenses, 1);
  document.getElementById(target).innerHTML = [
    { label: "الإيرادات", amount: income, className: "" },
    { label: "المصروفات", amount: expenses, className: "expense" }
  ].map(item => `<div class="chart-group"><div class="chart-bar ${item.className}" style="height:${Math.max(3, item.amount / max * 100)}%" title="${formatMoney(item.amount)}"></div><span class="chart-label">${item.label}</span></div>`).join("");
}

function filteredInvoices() {
  const query = document.getElementById("invoice-search").value.trim().toLocaleLowerCase("ar");
  const kind = document.getElementById("invoice-kind-filter").value;
  const period = document.getElementById("invoice-period").value;
  const from = document.getElementById("invoice-from").value;
  const to = document.getElementById("invoice-to").value;
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const year = String(now.getFullYear());
  return invoices.filter(invoice => {
    const date = invoice.date || invoice.createdAt.slice(0, 10);
    return (kind === "all" || invoice.kind === kind) &&
      (!query || invoice.title.toLocaleLowerCase("ar").includes(query)) &&
      (period === "all" || (period === "month" ? date.startsWith(month) : date.startsWith(year))) &&
      (!from || date >= from) && (!to || date <= to);
  });
}

function updateFinanceView() {
  const visible = filteredInvoices();
  const income = visible.filter(item => item.kind === "income").reduce((sum, item) => sum + item.amount, 0);
  const expenses = visible.filter(item => item.kind === "expense").reduce((sum, item) => sum + item.amount, 0);
  renderTable("invoices-list", visible);
  renderChart("finance-chart-large", income, expenses);
  document.getElementById("finance-income").textContent = formatMoney(income);
  document.getElementById("finance-expenses").textContent = formatMoney(expenses);
  document.getElementById("finance-balance").textContent = formatMoney(income - expenses);
  document.getElementById("finance-filter-summary").textContent = `عرض ${visible.length} من أصل ${invoices.length} حركة مالية.`;
}

function renderAuditLog() {
  const labels = { create: "إضافة", upload: "رفع", delete: "حذف" };
  const entities = { contract: "عقد", invoice: "حركة مالية", file: "ملف" };
  const target = document.getElementById("audit-list");
  target.innerHTML = auditLog.length
    ? auditLog.slice(0, 10).map(item => `<tr><td>${labels[item.action] || "عملية"}</td><td>${entities[item.entity] || "سجل"}</td><td>${escapeHtml(item.entityId.slice(0, 8))}…</td><td>${formatDate(item.createdAt)}</td></tr>`).join("")
    : '<tr><td class="no-data" colspan="4">لا توجد عمليات مسجلة بعد.</td></tr>';
}

function renderContracts() {
  const list = document.getElementById("contracts-list");
  list.innerHTML = contracts.length ? contracts.map(contract => `<div class="saved-item"><span>▤</span><div><strong>${escapeHtml(contract.title)}</strong><small>${formatDate(contract.createdAt)} · اكتمال البنود المفحوصة ${contractScore(contract)}%</small></div><button class="report-button" data-report="${contract.id}">التقرير</button></div>`).join("") : '<p class="no-data">لم تحفظ أي عقود بعد.</p>';
  list.querySelectorAll("[data-report]").forEach(button => button.addEventListener("click", () => printContract(contracts.find(item => item.id === button.dataset.report))));
}

function renderFiles() {
  const list = document.getElementById("files-list");
  const category = document.getElementById("media-category-filter").value;
  const visibleFiles = files.filter(file => category === "all" || (file.category || "عام") === category);
  list.innerHTML = visibleFiles.length ? visibleFiles.map(file => `<article class="file-card"><div class="file-top"><span class="file-icon">${file.type.startsWith("image/") ? "▧" : "▤"}</span><button class="delete-file" data-delete="${file.id}" aria-label="حذف ${escapeHtml(file.name)}">×</button></div><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><small>${escapeHtml(file.category || "عام")} · ${(file.size / 1024).toFixed(0)} كيلوبايت · ${formatDate(file.createdAt)}</small><div><a href="/api/files/${file.id}" target="_blank" rel="noopener">معاينة / فتح ↗</a></div></article>`).join("") : '<p class="no-data">لا توجد ملفات في هذه الفئة.</p>';
  list.querySelectorAll("[data-delete]").forEach(button => button.addEventListener("click", async () => {
    const file = files.find(item => item.id === button.dataset.delete);
    if (!file || !window.confirm(`هل تريد حذف الملف "${file.name}" نهائيًا؟`)) return;
    try {
      await api(`/api/files/${button.dataset.delete}`, { method: "DELETE" });
      await loadData();
      toast("تم حذف الملف.");
    } catch (error) { toast(error.message); }
  }));
}

function printContract(contract) {
  if (!contract) return;
  const report = window.open("", "_blank");
  if (!report) return toast("اسمح بالنوافذ المنبثقة لطباعة التقرير.");
  report.document.write(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${escapeHtml(contract.title)}</title><style>body{font:16px Arial,sans-serif;max-width:800px;margin:50px auto;line-height:1.9;color:#203431}h1{font-size:24px}li{margin:9px 0}.notice{padding:14px;background:#f2f6f4;border-radius:8px}</style><h1>تقرير مراجعة أولية: ${escapeHtml(contract.title)}</h1><p>تاريخ التقرير: ${formatDate(contract.createdAt)}</p><h2>اكتمال البنود المفحوصة: ${contractScore(contract)}%</h2><p>البنود المكتملة: ${contract.analysis.checkedCount ?? Math.max(0, 6 - contract.analysis.riskCount)} من ${contract.analysis.totalChecks ?? 6}</p><h3>بنود مقترح التحقق منها (${contract.analysis.riskCount})</h3><ul>${contract.analysis.findings.map(item => `<li>${escapeHtml(item.message)}</li>`).join("") || "<li>لم تُكتشف بنود ناقصة من قائمة الفحص العامة.</li>"}</ul><p class="notice">${escapeHtml(contract.analysis.disclaimer)}</p><button onclick="window.print()">طباعة أو حفظ PDF</button><script>window.onafterprint=()=>window.close()<\/script></html>`);
  report.document.close();
}

async function loadData() {
  [contracts, invoices, files, auditLog] = await Promise.all([api("/api/contracts"), api("/api/invoices"), api("/api/files"), api("/api/audit-log")]);
  const income = invoices.filter(item => item.kind === "income").reduce((sum, item) => sum + item.amount, 0);
  const expenses = invoices.filter(item => item.kind === "expense").reduce((sum, item) => sum + item.amount, 0);
  document.getElementById("stat-contracts").textContent = new Intl.NumberFormat("ar-SA").format(contracts.length);
  document.getElementById("stat-income").textContent = formatMoney(income);
  document.getElementById("stat-expenses").textContent = formatMoney(expenses);
  document.getElementById("stat-files").textContent = new Intl.NumberFormat("ar-SA").format(files.length);
  document.getElementById("finance-income").textContent = formatMoney(income);
  document.getElementById("finance-expenses").textContent = formatMoney(expenses);
  document.getElementById("finance-balance").textContent = formatMoney(income - expenses);
  renderTable("recent-invoices", invoices.slice(0, 5));
  renderChart("finance-chart", income, expenses);
  updateFinanceView();
  renderContracts();
  renderFiles();
  renderAuditLog();
}

document.querySelectorAll("[data-view]").forEach(link => link.addEventListener("click", event => {
  event.preventDefault();
  showView(link.dataset.view);
}));
document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => showView(button.dataset.go)));
document.getElementById("contract-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    currentContract = await api("/api/contracts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: form.get("title"), text: form.get("text") }) });
    const { analysis } = currentContract;
    document.getElementById("contract-result").innerHTML = `<div class="result-heading"><h3>${escapeHtml(currentContract.title)}</h3><button class="report-button" id="print-contract">طباعة / PDF ↗</button></div><div class="risk-summary">اكتمال البنود المفحوصة: ${analysis.score}% (${analysis.checkedCount} من ${analysis.totalChecks}) · ${analysis.riskCount} بندًا للمراجعة البشرية.</div>${analysis.findings.map(item => `<div class="finding">⚠ ${escapeHtml(item.message)}</div>`).join("") || '<div class="finding">✓ لم تُكتشف بنود ناقصة من قائمة الفحص العامة.</div>'}<p class="disclaimer">${escapeHtml(analysis.disclaimer)}</p>`;
    document.getElementById("print-contract").addEventListener("click", () => printContract(currentContract));
    event.currentTarget.reset();
    await loadData();
    toast("تم حفظ العقد وإكمال الفحص الأولي.");
  } catch (error) { toast(error.message); }
});
document.getElementById("invoice-date").value = new Date().toISOString().slice(0, 10);
document.getElementById("invoice-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: form.get("title"), amount: form.get("amount"), kind: form.get("kind"), date: form.get("date") }) });
    event.currentTarget.reset();
    document.getElementById("invoice-date").value = new Date().toISOString().slice(0, 10);
    await loadData();
    toast("تم حفظ الحركة المالية.");
  } catch (error) { toast(error.message); }
});
document.getElementById("upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData();
  const selectedFile = document.getElementById("media-file").files[0];
  if (!selectedFile) return;
  form.append("file", selectedFile);
  form.append("category", document.getElementById("media-category").value);
  try {
    await api("/api/files", { method: "POST", body: form });
    event.currentTarget.reset();
    clearMediaPreview();
    await loadData();
    toast("تم رفع الملف بأمان.");
  } catch (error) { toast(error.message); }
});
function clearMediaPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  document.getElementById("media-preview").replaceChildren();
}

document.getElementById("media-file").addEventListener("change", event => {
  clearMediaPreview();
  const file = event.currentTarget.files[0];
  if (!file) return;
  const preview = document.getElementById("media-preview");
  preview.append(document.createTextNode(`${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} ميغابايت`));
  previewUrl = URL.createObjectURL(file);
  if (file.type.startsWith("image/")) {
    const image = document.createElement("img");
    image.src = previewUrl;
    image.alt = `معاينة ${file.name}`;
    preview.append(image);
  } else if (file.type === "application/pdf") {
    const frame = document.createElement("iframe");
    frame.src = previewUrl;
    frame.title = `معاينة ${file.name}`;
    frame.setAttribute("sandbox", "");
    preview.append(frame);
  } else if (file.type === "text/plain") {
    const selectedUrl = previewUrl;
    file.text().then(text => {
      if (previewUrl !== selectedUrl) return;
      const content = document.createElement("pre");
      content.textContent = text.slice(0, 4000);
      preview.append(content);
    });
  }
});
document.getElementById("media-category-filter").addEventListener("change", renderFiles);
["invoice-search", "invoice-kind-filter", "invoice-period", "invoice-from", "invoice-to"].forEach(id =>
  document.getElementById(id).addEventListener("input", updateFinanceView)
);
document.getElementById("export-finance").addEventListener("click", () => {
  const escapeCell = value => {
    const text = String(value);
    const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = [["الوصف", "التاريخ", "النوع", "المبلغ (ر.س)"], ...filteredInvoices().map(item => [
    item.title, item.date || item.createdAt.slice(0, 10), item.kind === "income" ? "إيراد" : "مصروف", item.amount
  ])];
  const csv = `\uFEFF${rows.map(row => row.map(escapeCell).join(",")).join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "naib-finance.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
document.getElementById("print-finance").addEventListener("click", () => window.print());
showView(["overview", "contracts", "finance", "media"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview");
loadData().catch(error => toast(error.message));
