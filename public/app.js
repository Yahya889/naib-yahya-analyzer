const tokenKey = 'naib-session';
const labels = { income: 'إيراد', expense: 'مصروف', purchase: 'مشتريات', admin: 'مسؤول', staff: 'مستخدم' };
const permitStatusLabels = {
  active: 'ساري',
  upcoming: 'لم يبدأ بعد',
  expiring: 'ينتهي خلال 30 يوماً',
  expired: 'منتهي'
};
const pages = {
  dashboard: 'الرئيسية',
  security: 'أمن الموقع',
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
  const nameField = document.querySelector('#account-name-field');
  const setupKeyField = document.querySelector('#setup-key-field');
  nameField.hidden = !registering;
  nameField.querySelector('input').required = registering;
  setupKeyField.hidden = !registering;
  setupKeyField.querySelector('input').required = registering;
  document.querySelector('#access-notice').hidden = registering;
  const loginIdInput = authForm.querySelector('input[name="loginId"]');
  loginIdInput.inputMode = registering ? 'text' : 'numeric';
  loginIdInput.pattern = registering ? '[A-Za-z0-9_.-]{6,32}' : '[0-9]{10}|[A-Za-z0-9_.-]{6,32}';
  loginIdInput.maxLength = 32;
  document.querySelector('#login-id-label').firstChild.textContent = registering
    ? 'معرف المالك الخاص'
    : 'رقم الهوية أو معرف الدخول';
  authForm.querySelector('button[type="submit"]').textContent = registering ? 'إنشاء الحساب الأول' : 'تسجيل الدخول';
  authForm.querySelector('input[name="password"]').autocomplete = registering ? 'new-password' : 'current-password';
  setupButton.textContent = registering ? 'العودة لتسجيل الدخول' : 'إعداد الحساب الأول';
  setAuthMessage(registering ? 'اختر معرف دخول خاصاً لا يكشف صلاحية حسابك، وأدخل اسمك الكامل.' : '');
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(authForm));
  if (registering) {
    fields.ownerLoginId = fields.loginId;
    delete fields.loginId;
  }
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
    document.querySelector('#user-label').textContent = currentUser.username;
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
  document.querySelector('#account-name-field').hidden = true;
  document.querySelector('#account-name-field input').required = false;
  document.querySelector('#setup-key-field').hidden = true;
  document.querySelector('#setup-key-field input').required = false;
  document.querySelector('#login-id-label').firstChild.textContent = 'رقم الهوية أو معرف الدخول';
  document.querySelector('#access-notice').hidden = false;
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
    if (page === 'security') await loadSecurity();
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

document.querySelector('#access-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = Object.fromEntries(new FormData(form));
  fields.people = [...form.querySelectorAll('.access-person')].map((person) => ({
    name: person.querySelector('[name="personName"]').value,
    identityNumber: person.querySelector('[name="identityNumber"]').value,
    phone: person.querySelector('[name="phone"]').value
  }));
  try {
    await api('/api/security/access', { method: 'POST', body: JSON.stringify(fields) });
    form.reset();
    document.querySelector('#access-people-list').replaceChildren();
    addAccessPerson();
    await loadSecurity();
    showToast('تم تسجيل دخول المجموعة.');
  } catch (error) { showToast(error.message); }
});

document.querySelector('#add-access-person').addEventListener('click', () => addAccessPerson());
document.querySelector('#access-status').addEventListener('change', loadAccessRecords);
document.querySelector('#access-search').addEventListener('input', loadAccessRecords);

document.querySelector('#permit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/security/permits', { method: 'POST', body: new FormData(form) });
    form.reset();
    await loadSecurity();
    showToast('تم حفظ تصريح المركبة وصورته.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

document.querySelector('#report-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/security/reports', { method: 'POST', body: new FormData(form) });
    form.reset();
    await loadReports();
    showToast('تم حفظ التقرير وصورته.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

document.querySelector('#procedure-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/security/procedures', { method: 'POST', body: new FormData(form) });
    form.reset();
    await loadProcedures();
    showToast('تم حفظ الإجراء اليومي باسم المستخدم.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

document.querySelector('#permit-search').addEventListener('input', loadPermits);

document.querySelector('#vehicle-lookup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const plate = event.currentTarget.elements.plate.value.trim();
  const result = document.querySelector('#vehicle-lookup-result');
  result.replaceChildren();
  try {
    const vehicle = await api(`/api/security/vehicles?plate=${encodeURIComponent(plate)}`);
    renderVehicleLookup(vehicle);
  } catch (error) { showToast(error.message); }
});

function renderVehicleLookup(vehicle) {
  const result = document.querySelector('#vehicle-lookup-result');
  result.replaceChildren();
  if (!vehicle.vehicle_code) return appendEmpty(result, 'لم يتم العثور على مركبة مسجلة بهذا الرقم.');
  const heading = document.createElement('div');
  heading.className = 'vehicle-lookup-heading';
  heading.append(
    textElement('strong', `المركبة ${vehicle.plate}`),
    textElement('span', `الرمز الثابت: ${vehicle.vehicle_code}`)
  );
  result.append(heading);
  if (vehicle.permits.length) {
    result.append(textElement('h3', 'التصاريح'));
    vehicle.permits.forEach((permit) => {
      const card = document.createElement('article');
      card.className = 'vehicle-lookup-card';
      card.append(
        textElement('strong', `${permit.permit_number} · ${permitStatusLabels[permit.status]}`),
        textElement('span', `السائق: ${permit.driver_name} · الهوية: ${permit.identity_number} · الهاتف: ${permit.phone}`),
        textElement('span', `الجهة: ${permit.organization || '—'} · الغرض: ${permit.purpose}`),
        textElement('span', `الصلاحية: ${permit.valid_from} إلى ${permit.valid_until}`)
      );
      result.append(card);
    });
  }
  if (vehicle.access.length) {
    result.append(textElement('h3', 'سجل الدخول'));
    vehicle.access.forEach((visit) => {
      const card = document.createElement('article');
      card.className = 'vehicle-lookup-card';
      card.append(
        textElement('strong', `البوابة ${visit.gate} · ${visit.person_count} أشخاص`),
        textElement('span', `الأشخاص: ${visit.members.map((member) => `${member.name} (${member.identity_number})`).join('، ')}`),
        textElement('span', `الغرض: ${visit.purpose} · الدخول: ${formatTimestamp(visit.entered_at)} · الخروج: ${visit.exited_at ? formatTimestamp(visit.exited_at) : 'داخل الموقع'}`)
      );
      result.append(card);
    });
  }
}

async function loadSecurity() {
  const [summary] = await Promise.all([
    api('/api/security/summary'),
    loadAccessRecords(),
    loadPermits(),
    loadReports(),
    loadProcedures()
  ]);
  document.querySelector('#security-inside-count').textContent = formatMoney(summary.people_inside);
  document.querySelector('#security-active-visits').textContent = formatMoney(summary.active_visits);
  document.querySelector('#security-expiring-count').textContent = formatMoney(summary.expired_permits + summary.expiring_permits);
}

async function loadAccessRecords() {
  const status = document.querySelector('#access-status').value;
  const search = document.querySelector('#access-search').value;
  const records = await api(`/api/security/access?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`);
  const body = document.querySelector('#access-list');
  body.replaceChildren();
  if (!records.length) return appendTableEmpty(body, 7, 'لا توجد سجلات دخول مطابقة.');
  records.forEach((record) => {
    const row = document.createElement('tr');
    const person = document.createElement('td');
    const memberList = document.createElement('div');
    memberList.className = 'access-member-list';
    record.members.forEach((member) => {
      const details = document.createElement('div');
      details.append(textElement('strong', member.name), textElement('small', `${member.identity_number} · ${member.phone}`));
      memberList.append(details);
    });
    person.append(memberList);
    const reason = document.createElement('td');
    reason.append(textElement('span', record.organization || '—'), textElement('small', record.purpose));
    const count = document.createElement('td');
    count.textContent = formatMoney(record.person_count);
    const gate = document.createElement('td');
    gate.append(
      textElement('span', record.gate),
      textElement('small', record.vehicle_plate ? `${record.vehicle_plate} · ${record.vehicle_code || ''}` : '—')
    );
    const entered = document.createElement('td');
    entered.textContent = formatTimestamp(record.entered_at);
    const exited = document.createElement('td');
    exited.textContent = record.exited_at ? formatTimestamp(record.exited_at) : 'داخل الموقع';
    const action = document.createElement('td');
    if (!record.exited_at) {
      const leave = document.createElement('button');
      leave.type = 'button';
      leave.className = 'button secondary table-button';
      leave.textContent = 'تسجيل الخروج';
      leave.addEventListener('click', async () => {
        leave.disabled = true;
        try {
          await api(`/api/security/access/${record.id}/exit`, { method: 'POST' });
          await loadSecurity();
          showToast('تم تسجيل خروج المجموعة.');
        } catch (error) { showToast(error.message); }
      });
      action.append(leave);
    }
    row.append(person, reason, count, gate, entered, exited, action);
    body.append(row);
  });
}

function addAccessPerson() {
  const container = document.querySelector('#access-people-list');
  if (container.childElementCount >= 200) {
    showToast('لا يمكن إضافة أكثر من 200 شخص في السجل الواحد.');
    return;
  }
  const person = document.createElement('fieldset');
  person.className = 'access-person';
  person.append(textElement('legend', `بيانات الشخص ${container.childElementCount + 1}`));
  const fields = document.createElement('div');
  fields.className = 'form-grid security-form-grid';
  for (const [name, labelText, maxLength, type] of [
    ['personName', 'الاسم الكامل', 120, 'text'],
    ['identityNumber', 'رقم الهوية / الموظف', 40, 'text'],
    ['phone', 'رقم الهاتف', 30, 'tel']
  ]) {
    const label = textElement('label', labelText);
    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    input.maxLength = maxLength;
    input.required = true;
    label.append(input);
    fields.append(label);
  }
  const actions = document.createElement('div');
  actions.className = 'access-person-actions';
  if (container.childElementCount > 0) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.textContent = 'إزالة الشخص';
    remove.addEventListener('click', () => {
      person.remove();
      [...container.children].forEach((entry, index) => {
        entry.querySelector('legend').textContent = `بيانات الشخص ${index + 1}`;
      });
      container.firstElementChild.querySelector('.access-person-actions').replaceChildren();
    });
    actions.append(remove);
  }
  person.append(fields, actions);
  container.append(person);
  if (container.childElementCount === 2) {
    const firstActions = container.firstElementChild.querySelector('.access-person-actions');
    const removeFirst = document.createElement('button');
    removeFirst.type = 'button';
    removeFirst.className = 'icon-button';
    removeFirst.textContent = 'إزالة الشخص';
    removeFirst.addEventListener('click', () => {
      container.firstElementChild.remove();
      [...container.children].forEach((entry, index) => {
        entry.querySelector('legend').textContent = `بيانات الشخص ${index + 1}`;
      });
      container.firstElementChild.querySelector('.access-person-actions').replaceChildren();
    });
    firstActions.append(removeFirst);
  }
}

async function loadPermits() {
  const search = document.querySelector('#permit-search').value;
  const permits = await api(`/api/security/permits?search=${encodeURIComponent(search)}`);
  const body = document.querySelector('#permit-list');
  body.replaceChildren();
  const alerts = permits.filter((permit) => permit.status === 'expired' || permit.status === 'expiring');
  renderPermitAlerts(alerts);
  if (!permits.length) return appendTableEmpty(body, 7, 'لا توجد تصاريح مركبات مطابقة.');
  permits.forEach((permit) => {
    const row = document.createElement('tr');
    const permitCell = document.createElement('td');
    const permitDetails = document.createElement('div');
    permitDetails.className = 'permit-cell';
    const photo = document.createElement('img');
    photo.className = 'permit-thumb';
    photo.alt = `صورة التصريح ${permit.permit_number}`;
    api(`/api/media/${permit.media_id}/preview`)
      .then((blob) => { photo.src = URL.createObjectURL(blob); })
      .catch(() => { photo.alt = 'تعذرت معاينة الصورة'; });
    const permitNumber = document.createElement('div');
    permitNumber.append(
      textElement('strong', permit.permit_number),
      textElement('small', `رمز المركبة ${permit.vehicle_code || '—'}`)
    );
    permitDetails.append(photo, permitNumber);
    permitCell.append(permitDetails);
    const driver = document.createElement('td');
    driver.append(textElement('span', permit.driver_name), textElement('small', permit.organization || '—'));
    const contact = document.createElement('td');
    contact.append(textElement('span', permit.identity_number), textElement('small', permit.phone));
    const details = document.createElement('td');
    details.append(textElement('span', permit.purpose), textElement('small', permit.organization || '—'));
    const validity = document.createElement('td');
    validity.append(textElement('span', permit.valid_until), textElement('small', `من ${permit.valid_from}`));
    const status = document.createElement('td');
    const badge = textElement('span', permitStatusLabels[permit.status]);
    badge.className = `tag permit-status ${permit.status}`;
    status.append(badge);
    row.append(permitCell, textElement('td', permit.vehicle_plate), driver, contact, details, validity, status);
    body.append(row);
  });
}

async function loadReports() {
  const reports = await api('/api/security/reports');
  const list = document.querySelector('#report-list');
  list.replaceChildren();
  if (!reports.length) return appendEmpty(list, 'لا توجد تقارير أمنية محفوظة بعد.');
  reports.forEach((report) => {
    const card = document.createElement('article');
    card.className = 'report-card';
    const photo = document.createElement('img');
    photo.className = 'report-photo';
    photo.alt = `صورة التقرير ${report.title}`;
    api(`/api/media/${report.media_id}/preview`)
      .then((blob) => { photo.src = URL.createObjectURL(blob); })
      .catch(() => { photo.alt = 'تعذرت معاينة صورة التقرير'; });
    const info = document.createElement('div');
    info.append(
      textElement('strong', report.title),
      textElement('small', `${report.category} · ${report.location || 'الموقع غير محدد'} · ${formatTimestamp(report.created_at)}`),
      textElement('p', report.details)
    );
    card.append(photo, info);
    list.append(card);
  });
}

async function loadProcedures() {
  const procedures = await api('/api/security/procedures');
  const list = document.querySelector('#procedure-list');
  list.replaceChildren();
  if (!procedures.length) return appendEmpty(list, 'لا توجد إجراءات يومية مسجلة بعد.');
  procedures.forEach((procedure) => {
    const card = document.createElement('article');
    card.className = 'report-card';
    if (procedure.media_id) {
      const photo = document.createElement('img');
      photo.className = 'report-photo';
      photo.alt = `صورة الإجراء ${procedure.title}`;
      api(`/api/media/${procedure.media_id}/preview`)
        .then((blob) => { photo.src = URL.createObjectURL(blob); })
        .catch(() => { photo.alt = 'تعذرت معاينة الصورة'; });
      card.append(photo);
    }
    const info = document.createElement('div');
    info.append(
      textElement('strong', procedure.title),
      textElement('small', `${procedure.category} · ${procedure.location || 'الموقع غير محدد'} · ${formatTimestamp(procedure.created_at)} · سجله: ${procedure.created_by_name}`),
      textElement('p', procedure.details)
    );
    card.append(info);
    list.append(card);
  });
}

function renderPermitAlerts(permits) {
  const container = document.querySelector('#permit-alerts');
  container.replaceChildren();
  if (!permits.length) return appendEmpty(container, 'لا توجد تصاريح منتهية أو قريبة الانتهاء.');
  permits.forEach((permit) => {
    const alert = document.createElement('div');
    alert.className = `permit-alert ${permit.status}`;
    alert.append(
      textElement('strong', `${permitStatusLabels[permit.status]} · ${permit.permit_number}`),
      textElement('span', `المركبة ${permit.vehicle_plate} · السائق ${permit.driver_name} · تاريخ الانتهاء ${permit.valid_until}`)
    );
    container.append(alert);
  });
}

function textElement(tagName, text) {
  const element = document.createElement(tagName);
  element.textContent = text;
  return element;
}

function appendTableEmpty(body, columnCount, message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = columnCount;
  cell.className = 'empty-row';
  cell.textContent = message;
  row.append(cell);
  body.append(row);
}

function formatTimestamp(timestamp) {
  return new Date(timestamp.replace(' ', 'T') + 'Z').toLocaleString('ar-SA');
}

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
    const identity = document.createElement('small');
    identity.textContent = user.identity_number || 'لم يُربط رقم هوية بعد';
    details.append(name, identity, date);
    const identityForm = document.createElement('form');
    identityForm.className = 'identity-link-form';
    const identityInput = document.createElement('input');
    identityInput.name = 'identityNumber';
    identityInput.inputMode = 'numeric';
    identityInput.pattern = '[0-9]{10}';
    identityInput.maxLength = 10;
    identityInput.placeholder = 'رقم الهوية';
    identityInput.value = user.identity_number || '';
    identityInput.required = true;
    const updateIdentity = document.createElement('button');
    updateIdentity.type = 'submit';
    updateIdentity.className = 'button secondary';
    updateIdentity.textContent = 'حفظ الهوية';
    identityForm.append(identityInput, updateIdentity);
    identityForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      updateIdentity.disabled = true;
      try {
        await api(`/api/users/${user.id}/identity`, {
          method: 'PATCH',
          body: JSON.stringify({ identityNumber: identityInput.value })
        });
        await loadUsers();
        showToast('تم ربط رقم الهوية بالحساب.');
      } catch (error) { showToast(error.message); }
      finally { updateIdentity.disabled = false; }
    });
    const role = document.createElement('span');
    role.className = 'tag';
    role.textContent = labels[user.role];
    row.append(details, identityForm, role);
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
addAccessPerson();
if (localStorage.getItem(tokenKey)) enterApp();
else checkSetup();
