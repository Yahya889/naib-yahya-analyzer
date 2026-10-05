const tokenKey = 'naib-session';
const labels = { income: 'إيراد', expense: 'مصروف', purchase: 'مشتريات', admin: 'مسؤول', staff: 'مستخدم' };
const pages = {
  dashboard: 'الرئيسية',
  documents: 'تحليل المستندات',
  accounting: 'المحاسبة المالية',
  media: 'الوسائط والملفات',
  users: 'المستخدمون والصلاحيات',
  activity: 'سجل العمليات'
};
const authView = document.querySelector('#auth-view');
const appView = document.querySelector('#app-view');
const authForm = document.querySelector('#auth-form');
const authMessage = document.querySelector('#auth-message');
const setupButton = document.querySelector('#setup-button');
let registering = false;
let currentUser;
let toastTimeout;

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = localStorage.getItem(tokenKey);
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  if (response.status === 204) return null;
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.blob();
  if (!response.ok) {
    if (response.status === 401 && token) logout(false);
    throw new Error(data?.error || 'تعذر إكمال العملية.');
  }
  return data;
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3200);
}

function formatMoney(amount) {
  return new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 2 }).format(amount || 0);
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setAuthMessage(message) {
  authMessage.textContent = message;
}

async function checkSetup() {
  try {
    const status = await api('/api/auth/status');
    setupButton.hidden = status.configured;
    setupButton.textContent = status.configured ? '' : 'إعداد الحساب الأول';
  } catch {
    setAuthMessage('تعذر الاتصال بالخادم. تحقق من تشغيل التطبيق ثم أعد المحاولة.');
  }
}

setupButton.addEventListener('click', () => {
  registering = !registering;
  authForm.querySelector('button[type="submit"]').textContent = registering ? 'إنشاء الحساب الأول' : 'تسجيل الدخول';
  authForm.querySelector('input[name="password"]').autocomplete = registering ? 'new-password' : 'current-password';
  setupButton.textContent = registering ? 'العودة لتسجيل الدخول' : 'إعداد الحساب الأول';
  setAuthMessage(registering ? 'الحساب الأول يحصل على صلاحية مسؤول النظام.' : '');
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(authForm));
  setAuthMessage('');
  try {
    const result = await api(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(fields)
    });
    localStorage.setItem(tokenKey, result.token);
    await enterApp();
  } catch (error) {
    setAuthMessage(error.message);
  }
});

async function enterApp() {
  try {
    currentUser = await api('/api/auth/me');
    authView.hidden = true;
    appView.hidden = false;
    document.querySelector('#user-label').textContent = `${currentUser.username} · ${labels[currentUser.role]}`;
    document.querySelector('#users-link').hidden = currentUser.role !== 'admin';
    if (location.hash === '#users' && currentUser.role !== 'admin') location.hash = '#dashboard';
    await navigate();
  } catch {
    logout(false);
  }
}

function logout(showMessage = true) {
  localStorage.removeItem(tokenKey);
  currentUser = undefined;
  appView.hidden = true;
  authView.hidden = false;
  registering = false;
  authForm.reset();
  authForm.querySelector('button[type="submit"]').textContent = 'تسجيل الدخول';
  setupButton.textContent = 'إعداد الحساب الأول';
  if (showMessage) setAuthMessage('تم تسجيل الخروج.');
  checkSetup();
}

document.querySelector('#logout-button').addEventListener('click', () => logout());

async function navigate() {
  if (!currentUser) return;
  let page = location.hash.slice(1) || 'dashboard';
  if (!pages[page] || (page === 'users' && currentUser.role !== 'admin')) page = 'dashboard';
  if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  document.querySelectorAll('.page').forEach((element) => { element.hidden = element.id !== `page-${page}`; });
  document.querySelectorAll('.sidebar nav a').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  document.querySelector('#page-title').textContent = pages[page];
  try {
    if (page === 'dashboard') await loadDashboard();
    if (page === 'documents') await loadDocuments();
    if (page === 'accounting') await loadAccounting();
    if (page === 'media') await loadMedia();
    if (page === 'users') await loadUsers();
    if (page === 'activity') await loadActivity();
  } catch (error) {
    showToast(error.message);
  }
}

window.addEventListener('hashchange', navigate);

async function loadDashboard() {
  const [summary, documents] = await Promise.all([
    api('/api/accounting/summary'),
    api('/api/documents')
  ]);
  document.querySelector('#metric-income').textContent = formatMoney(summary.income);
  document.querySelector('#metric-expenses').textContent = formatMoney(summary.expenses);
  document.querySelector('#metric-balance').textContent = formatMoney(summary.balance);
  document.querySelector('#metric-documents').textContent = formatMoney(documents.length);
  document.querySelector('#chart-year').textContent = summary.year;
  renderChart(summary.monthly);
}

function renderChart(months) {
  const chart = document.querySelector('#chart');
  chart.replaceChildren();
  const max = Math.max(1, ...months.flatMap((month) => [month.income, month.expenses]));
  months.forEach((month) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'chart-month';
    const bars = document.createElement('div');
    bars.className = 'bars';
    for (const [amount, className, label] of [
      [month.income, 'bar', 'الإيرادات'],
      [month.expenses, 'bar expenses', 'المصروفات']
    ]) {
      const bar = document.createElement('span');
      bar.className = className;
      bar.style.height = `${Math.max(2, (amount / max) * 140)}px`;
      bar.title = `${label}: ${formatMoney(amount)}`;
      bars.append(bar);
    }
    const monthLabel = document.createElement('span');
    monthLabel.textContent = new Intl.DateTimeFormat('ar-SA', { month: 'short' }).format(new Date(Number(document.querySelector('#chart-year').textContent), Number(month.month) - 1, 1));
    wrapper.append(bars, monthLabel);
    chart.append(wrapper);
  });
}

function addPrintButton(container) {
  const printButton = document.createElement('button');
  printButton.type = 'button';
  printButton.className = 'button secondary';
  printButton.textContent = 'طباعة / حفظ PDF';
  printButton.addEventListener('click', () => window.print());
  container.append(printButton);
}

document.querySelector('#document-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/documents/analyze', { method: 'POST', body: JSON.stringify(fields) });
    renderAnalysis(result);
    form.reset();
    showToast('تم حفظ نتيجة الفحص الأولي.');
    await loadDocuments();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

function renderAnalysis(documentResult) {
  const result = document.querySelector('#analysis-result');
  result.classList.remove('empty-state');
  result.replaceChildren();
  const score = document.createElement('div');
  score.className = 'score-ring';
  score.textContent = `${documentResult.analysis.score}%`;
  const title = document.createElement('h3');
  title.textContent = documentResult.title;
  const subtitle = document.createElement('p');
  subtitle.textContent = 'مؤشر اكتمال البنود الظاهرة';
  const clauses = document.createElement('ul');
  clauses.className = 'clause-list';
  documentResult.analysis.clauses.forEach((clause) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = clause.name;
    const status = document.createElement('span');
    status.className = clause.present ? 'present' : 'missing';
    status.textContent = clause.present ? 'وُجد' : 'غير ظاهر';
    row.append(name, status);
    clauses.append(row);
  });
  const disclaimer = document.createElement('p');
  disclaimer.className = 'result-warning';
  disclaimer.textContent = documentResult.analysis.disclaimer;
  const reportActions = document.createElement('div');
  reportActions.className = 'list-actions';
  addPrintButton(reportActions);
  const jsonButton = document.createElement('button');
  jsonButton.type = 'button';
  jsonButton.className = 'button secondary';
  jsonButton.textContent = 'تنزيل JSON';
  jsonButton.addEventListener('click', () => {
    const report = {
      title: documentResult.title,
      content: documentResult.content,
      analysis: documentResult.analysis
    };
    downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `analysis-${documentResult.id}.json`);
  });
  reportActions.append(jsonButton);
  result.append(score, title, subtitle, clauses, disclaimer, reportActions);
}

async function loadDocuments() {
  const documents = await api('/api/documents');
  const list = document.querySelector('#document-list');
  list.replaceChildren();
  if (!documents.length) return appendEmpty(list, 'لا توجد مستندات محفوظة بعد.');
  documents.forEach((documentResult) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = documentResult.title;
    const date = document.createElement('small');
    date.textContent = `${new Date(documentResult.created_at.replace(' ', 'T') + 'Z').toLocaleString('ar-SA')} · نتيجة الفحص ${JSON.parse(documentResult.analysis_json).score}%`;
    details.append(title, date);
    const actions = document.createElement('div');
    actions.className = 'list-actions';
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'button secondary';
    view.textContent = 'عرض التحليل';
    view.addEventListener('click', async () => {
      try {
        renderAnalysis(await api(`/api/documents/${documentResult.id}`));
        document.querySelector('#analysis-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (error) { showToast(error.message); }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.textContent = 'حذف';
    remove.addEventListener('click', async () => {
      if (!confirm('هل تريد حذف المستند؟')) return;
      try { await api(`/api/documents/${documentResult.id}`, { method: 'DELETE' }); await loadDocuments(); showToast('تم حذف المستند.'); }
      catch (error) { showToast(error.message); }
    });
    actions.append(view, remove);
    row.append(details, actions);
    list.append(row);
  });
}

document.querySelector('#transaction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  fields.amount = Number(fields.amount);
  try {
    await api('/api/accounting/transactions', { method: 'POST', body: JSON.stringify(fields) });
    event.currentTarget.reset();
    event.currentTarget.elements.date.value = new Date().toISOString().slice(0, 10);
    await loadAccounting();
    showToast('تم حفظ الحركة المالية.');
  } catch (error) { showToast(error.message); }
});

document.querySelector('#transaction-search').addEventListener('input', loadTransactions);

async function loadAccounting() {
  const summary = await api('/api/accounting/summary');
  document.querySelector('#account-income').textContent = formatMoney(summary.income);
  document.querySelector('#account-expenses').textContent = formatMoney(summary.expenses);
  document.querySelector('#account-balance').textContent = formatMoney(summary.balance);
  await loadTransactions();
}

async function loadTransactions() {
  const search = document.querySelector('#transaction-search').value;
  const transactions = await api(`/api/accounting/transactions?search=${encodeURIComponent(search)}`);
  const body = document.querySelector('#transaction-list');
  body.replaceChildren();
  if (!transactions.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty-row';
    cell.textContent = 'لا توجد حركات مالية.';
    row.append(cell);
    body.append(row);
    return;
  }
  transactions.forEach((transaction) => {
    const row = document.createElement('tr');
    [transaction.transaction_date, labels[transaction.kind], transaction.description].forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    });
    const amount = document.createElement('td');
    amount.className = 'amount-cell';
    amount.textContent = `${formatMoney(transaction.amount)} ${transaction.currency}`;
    row.append(amount);
    const action = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.textContent = 'حذف';
    remove.addEventListener('click', async () => {
      if (!confirm('هل تريد حذف هذه الحركة المالية؟')) return;
      try { await api(`/api/accounting/transactions/${transaction.id}`, { method: 'DELETE' }); await loadAccounting(); showToast('تم حذف الحركة.'); }
      catch (error) { showToast(error.message); }
    });
    action.append(remove);
    row.append(action);
    body.append(row);
  });
}

document.querySelector('#export-link').addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    const file = await api('/api/accounting/export.csv');
    downloadBlob(file, 'transactions.csv');
  } catch (error) { showToast(error.message); }
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

document.querySelector('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData();
  data.append('category', form.elements.category.value);
  data.append('file', form.elements.file.files[0]);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/media', { method: 'POST', body: data });
    form.reset();
    await loadMedia();
    showToast('تم رفع الملف بنجاح.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

async function loadMedia() {
  const files = await api('/api/media');
  const list = document.querySelector('#media-list');
  list.replaceChildren();
  if (!files.length) return appendEmpty(list, 'لا توجد ملفات مرفوعة بعد.');
  files.forEach((file) => {
    const card = document.createElement('article');
    card.className = 'media-card';
    const preview = file.mime_type.startsWith('image/')
      ? document.createElement('img')
      : document.createElement('div');
    preview.className = 'media-preview';
    if (preview instanceof HTMLImageElement) {
      preview.alt = file.original_name;
      api(`/api/media/${file.id}/preview`).then((blob) => { preview.src = URL.createObjectURL(blob); }).catch(() => {});
    } else {
      preview.textContent = file.mime_type === 'application/pdf' ? 'PDF' : '▤';
      preview.setAttribute('aria-label', 'ملف');
    }
    const info = document.createElement('div');
    info.className = 'media-info';
    const name = document.createElement('strong');
    name.textContent = file.original_name;
    const details = document.createElement('small');
    details.textContent = `${file.category} · ${formatSize(file.size)}`;
    const actions = document.createElement('div');
    actions.className = 'media-actions';
    const download = document.createElement('a');
    download.href = '#';
    download.textContent = 'تنزيل';
    download.addEventListener('click', async (event) => {
      event.preventDefault();
      try { downloadBlob(await api(`/api/media/${file.id}`), file.original_name); }
      catch (error) { showToast(error.message); }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.textContent = 'حذف';
    remove.addEventListener('click', async () => {
      if (!confirm('هل تريد حذف الملف نهائياً؟')) return;
      try { await api(`/api/media/${file.id}`, { method: 'DELETE' }); await loadMedia(); showToast('تم حذف الملف.'); }
      catch (error) { showToast(error.message); }
    });
    actions.append(download, remove);
    info.append(name, details, actions);
    card.append(preview, info);
    list.append(card);
  });
}

document.querySelector('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify(fields) });
    event.currentTarget.reset();
    await loadUsers();
    showToast('تمت إضافة المستخدم.');
  } catch (error) { showToast(error.message); }
});

async function loadUsers() {
  const users = await api('/api/users');
  const list = document.querySelector('#user-list');
  list.replaceChildren();
  users.forEach((user) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = user.username;
    const date = document.createElement('small');
    date.textContent = new Date(user.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('ar-SA');
    details.append(name, date);
    const role = document.createElement('span');
    role.className = 'tag';
    role.textContent = labels[user.role];
    row.append(details, role);
    list.append(row);
  });
}

async function loadActivity() {
  const entries = await api('/api/audit');
  const list = document.querySelector('#activity-list');
  list.replaceChildren();
  if (!entries.length) return appendEmpty(list, 'لا توجد عمليات مسجلة بعد.');
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    const action = document.createElement('strong');
    action.textContent = entry.action;
    const date = document.createElement('small');
    date.textContent = new Date(entry.created_at.replace(' ', 'T') + 'Z').toLocaleString('ar-SA');
    const details = document.createElement('small');
    details.textContent = entry.details;
    const text = document.createElement('div');
    text.append(action, date, details);
    row.append(text);
    list.append(row);
  });
}

function appendEmpty(container, message) {
  const empty = document.createElement('p');
  empty.className = 'empty-row';
  empty.textContent = message;
  container.append(empty);
}

document.querySelector('#transaction-form').elements.date.value = new Date().toISOString().slice(0, 10);
if (localStorage.getItem(tokenKey)) enterApp();
else checkSetup();
