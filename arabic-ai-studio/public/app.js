'use strict';

const tools = [
  { name: 'ChatGPT', category: 'مساعدات عامة', use: 'صياغة، تحليل، أفكار ومساعدة متعددة الوسائط.', url: 'https://chatgpt.com/' },
  { name: 'Claude', category: 'مساعدات عامة', use: 'الكتابة والتحليل والعمل مع سياقات طويلة.', url: 'https://claude.ai/' },
  { name: 'Google Gemini', category: 'مساعدات عامة', use: 'مساعد عام وتكامل مع منظومة Google حسب الخطة.', url: 'https://gemini.google.com/' },
  { name: 'Microsoft Copilot', category: 'مساعدات عامة', use: 'مساعدة عامة وإنتاجية وتكاملات Microsoft.', url: 'https://copilot.microsoft.com/' },
  { name: 'Perplexity', category: 'البحث والمعرفة', use: 'بحث ويب وإجابات مرتبطة بمصادر؛ تحقّق من الاستشهادات.', url: 'https://www.perplexity.ai/' },
  { name: 'NotebookLM', category: 'البحث والمعرفة', use: 'استكشاف مصادر المستخدم وإنشاء ملخصات وأسئلة عنها.', url: 'https://notebooklm.google.com/' },
  { name: 'Elicit', category: 'البحث والمعرفة', use: 'مساندة مراجعة الأدبيات والأبحاث العلمية.', url: 'https://elicit.com/' },
  { name: 'Consensus', category: 'البحث والمعرفة', use: 'البحث في الدراسات العلمية واستكشاف الأدلة المنشورة.', url: 'https://consensus.app/' },
  { name: 'GitHub Copilot', category: 'البرمجة والبيانات', use: 'اقتراح الشيفرة ومساعدة المطور داخل بيئة البرمجة.', url: 'https://github.com/features/copilot' },
  { name: 'Cursor', category: 'البرمجة والبيانات', use: 'محرر برمجي يتضمن ميزات مساعدة بالذكاء الاصطناعي.', url: 'https://cursor.com/' },
  { name: 'Replit', category: 'البرمجة والبيانات', use: 'بيئة تطوير عبر المتصفح مع أدوات مساعدة لبناء التطبيقات.', url: 'https://replit.com/' },
  { name: 'Hugging Face', category: 'البرمجة والبيانات', use: 'استكشاف نماذج ومجموعات بيانات وأدوات مفتوحة المصدر.', url: 'https://huggingface.co/' },
  { name: 'Midjourney', category: 'التصميم والصورة', use: 'إنشاء صور فنية من أوصاف نصية.', url: 'https://www.midjourney.com/' },
  { name: 'Adobe Firefly', category: 'التصميم والصورة', use: 'توليد وتحرير محتوى بصري ضمن أدوات Adobe.', url: 'https://firefly.adobe.com/' },
  { name: 'Canva Magic Studio', category: 'التصميم والصورة', use: 'ميزات توليد وتصميم ضمن Canva.', url: 'https://www.canva.com/magic/' },
  { name: 'Ideogram', category: 'التصميم والصورة', use: 'إنشاء صور وتصاميم تتضمن نصوصاً مرئية.', url: 'https://ideogram.ai/' },
  { name: 'Runway', category: 'الفيديو والصوت', use: 'إنشاء وتحرير مقاطع الفيديو بأدوات توليدية.', url: 'https://runwayml.com/' },
  { name: 'Google Veo', category: 'الفيديو والصوت', use: 'توليد فيديو بالذكاء الاصطناعي عبر منتجات Google المتاحة.', url: 'https://deepmind.google/models/veo/' },
  { name: 'ElevenLabs', category: 'الفيديو والصوت', use: 'توليد الصوت والكلام وأدوات صوتية متعددة.', url: 'https://elevenlabs.io/' },
  { name: 'Suno', category: 'الفيديو والصوت', use: 'توليد الموسيقى والأغاني من أوصاف نصية.', url: 'https://suno.com/' },
  { name: 'Descript', category: 'الفيديو والصوت', use: 'تحرير الصوت والفيديو وسير عمل يعتمد على النص.', url: 'https://www.descript.com/' },
  { name: 'Jasper', category: 'التسويق والمحتوى', use: 'سير عمل لإنشاء محتوى تسويقي للفرق والعلامات.', url: 'https://www.jasper.ai/' },
  { name: 'Copy.ai', category: 'التسويق والمحتوى', use: 'مساعدة في المحتوى التسويقي وسير عمل الأعمال.', url: 'https://www.copy.ai/' },
  { name: 'Zapier AI', category: 'الأتمتة والإنتاجية', use: 'ربط التطبيقات وأتمتة تدفقات العمل.', url: 'https://zapier.com/ai' },
  { name: 'Make', category: 'الأتمتة والإنتاجية', use: 'إنشاء تدفقات أتمتة مرئية بين الخدمات.', url: 'https://www.make.com/' },
  { name: 'n8n', category: 'الأتمتة والإنتاجية', use: 'أتمتة مرنة ذاتية الاستضافة أو سحابية.', url: 'https://n8n.io/' },
  { name: 'Ollama', category: 'نماذج محلية', use: 'تشغيل نماذج لغوية محلياً على الأجهزة المتوافقة.', url: 'https://ollama.com/' },
  { name: 'LM Studio', category: 'نماذج محلية', use: 'تنزيل وتجربة نماذج لغوية محلية بواجهة مكتبية.', url: 'https://lmstudio.ai/' }
];

const categories = ['الكل', ...new Set(tools.map((tool) => tool.category))];
const state = { category: 'الكل', reference: '', task: '', plan: '' };
const taskInput = document.querySelector('#task');
const domainInput = document.querySelector('#domain');
const resultInput = document.querySelector('#result');
const executeButton = document.querySelector('#execute-button');
const planButton = document.querySelector('#plan-button');
const formMessage = document.querySelector('#form-message');

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.tab-panel').forEach((panel) => { panel.hidden = panel.id !== tab.dataset.tab; });
  });
});

function renderCategories() {
  const container = document.querySelector('#tool-categories');
  container.replaceChildren();
  categories.forEach((category) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter-chip${state.category === category ? ' selected' : ''}`;
    button.textContent = category;
    button.addEventListener('click', () => {
      state.category = category;
      renderCategories();
      renderTools();
    });
    container.append(button);
  });
}

function renderTools() {
  const container = document.querySelector('#tool-list');
  const query = document.querySelector('#tool-search').value.trim().toLocaleLowerCase('ar');
  const matches = tools.filter((tool) =>
    (state.category === 'الكل' || state.category === tool.category) &&
    `${tool.name} ${tool.category} ${tool.use}`.toLocaleLowerCase('ar').includes(query)
  );
  container.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'لا توجد أدوات تطابق البحث.';
    container.append(empty);
    return;
  }
  matches.forEach((tool) => {
    const card = document.createElement('article');
    card.className = 'tool-card';
    const category = document.createElement('span');
    category.className = 'tag';
    category.textContent = tool.category;
    const title = document.createElement('h3');
    title.textContent = tool.name;
    const use = document.createElement('p');
    use.textContent = tool.use;
    const link = document.createElement('a');
    link.href = tool.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'الموقع الرسمي ↗';
    card.append(category, title, use, link);
    container.append(card);
  });
}

document.querySelector('#tool-search').addEventListener('input', renderTools);
renderCategories();
renderTools();

document.querySelector('#reference-file').addEventListener('change', async (event) => {
  const file = event.currentTarget.files[0];
  state.reference = '';
  if (!file) return;
  if (!/\.(txt|md)$/i.test(file.name) || file.size > 16 * 1024) {
    event.currentTarget.value = '';
    formMessage.textContent = 'اختر ملف TXT أو MD لا يتجاوز 16 كيلوبايت.';
    return;
  }
  state.reference = await file.text();
  formMessage.textContent = `تمت قراءة ${file.name} محلياً؛ سيُضمّن نصه عند إرسال الطلب إلى النموذج المحلي.`;
});

document.querySelector('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.task = taskInput.value.trim();
  if (!state.task) return;
  state.plan = '';
  executeButton.disabled = true;
  await runPhase('plan');
});

executeButton.addEventListener('click', async () => {
  if (!state.plan) return;
  executeButton.disabled = true;
  planButton.disabled = true;
  await runPhase('execute');
  planButton.disabled = false;
  executeButton.disabled = false;
});

async function runPhase(phase) {
  planButton.disabled = true;
  executeButton.disabled = true;
  formMessage.textContent = phase === 'plan' ? 'جارٍ إعداد الخطة على جهازك…' : 'جارٍ إنشاء المسودة محلياً…';
  document.querySelector('#result-title').textContent = phase === 'plan' ? 'الخطة المقترحة' : 'المسودة الناتجة';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phase,
        task: `${state.task}${state.reference ? `\n\nنص مرجعي قدّمه المستخدم:\n${state.reference}` : ''}`,
        domain: domainInput.value,
        ...(phase === 'execute' ? { plan: state.plan } : {})
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'تعذر إكمال المهمة.');
    resultInput.value = payload.answer;
    document.querySelector('#download-button').disabled = false;
    formMessage.textContent = phase === 'plan' ? 'راجع الخطة وعدّل وصف المهمة إن لزم، ثم اختر إنشاء المسودة.' : 'اكتملت المسودة. راجعها وتحقق من محتواها قبل الاستخدام.';
    if (phase === 'plan') {
      state.plan = payload.answer;
      executeButton.disabled = false;
    }
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    planButton.disabled = false;
    if (phase === 'execute') executeButton.disabled = !state.plan;
  }
}

document.querySelector('#download-button').addEventListener('click', () => {
  const file = new Blob([resultInput.value], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'مِداد-المسودة.md';
  link.click();
  URL.revokeObjectURL(url);
});

async function checkModel() {
  const status = document.querySelector('#model-status');
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    status.textContent = response.ok ? `نموذج محلي: ${health.model}` : 'تعذر فحص النموذج';
  } catch {
    status.textContent = 'تعذر الاتصال بالخادم المحلي';
  }
}
checkModel();
