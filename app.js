let appState = null;
let selectedLeadId = null;
let appMode = 'server';

const els = {
  leadList: document.querySelector('#lead-list'),
  detail: document.querySelector('#lead-detail'),
  statusLine: document.querySelector('#status-line'),
  bucketFilter: document.querySelector('#bucket-filter'),
  statusFilter: document.querySelector('#status-filter'),
  searchInput: document.querySelector('#search-input'),
  metricTotal: document.querySelector('#metric-total'),
  metricA: document.querySelector('#metric-a'),
  metricContact: document.querySelector('#metric-contact'),
  metricRun: document.querySelector('#metric-run'),
  sourcePolicies: document.querySelector('#source-policies'),
  seedFile: document.querySelector('#seed-file'),
  importButton: document.querySelector('#import-button'),
  exportButton: document.querySelector('#export-button')
};

function formatDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-Hans-AU', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function csvParse(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((items) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = items[index] || '';
    });
    return record;
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

async function loadState() {
  try {
    appState = await api('/api/state');
    appMode = 'server';
  } catch {
    appState = window.RadarEngine.readState();
    appMode = 'static';
  }
  if (!selectedLeadId && appState.lead_scores[0]) selectedLeadId = appState.lead_scores[0].lead_id;
  els.statusLine.textContent = appMode === 'server' ? '已载入 Mac mini 模式' : '已载入 GitHub Pages 模式';
  render();
}

async function runAction(action, payload = {}) {
  els.statusLine.textContent = '处理中';
  let result;
  if (appMode === 'server') {
    try {
      result = await api('/api/action', {
        method: 'POST',
        body: JSON.stringify({ action, payload })
      });
    } catch {
      appMode = 'static';
      result = await window.RadarEngine.runAction(action, payload);
    }
  } else {
    result = await window.RadarEngine.runAction(action, payload);
  }
  appState = result.state;
  els.statusLine.textContent = result.message;
  if (!appState.lead_scores.some((lead) => lead.lead_id === selectedLeadId)) {
    selectedLeadId = appState.lead_scores[0]?.lead_id || null;
  }
  render();
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportCsv() {
  let csv;
  if (appMode === 'server') {
    try {
      const response = await fetch('/api/export/leads.csv');
      if (!response.ok) throw new Error(response.statusText);
      csv = await response.text();
    } catch {
      appMode = 'static';
      csv = window.RadarEngine.exportLeadsCsv(appState);
    }
  } else {
    csv = window.RadarEngine.exportLeadsCsv(appState);
  }
  downloadCsv(csv, `sid-employer-leads-${new Date().toISOString().slice(0, 10)}.csv`);
  els.statusLine.textContent = 'CSV 已导出';
}

function getLeadBundle(lead) {
  const employer = appState.employers.find((item) => item.employer_id === lead.employer_id) || {};
  const job = appState.job_ads.find((item) => item.job_id === lead.latest_job_id) || {};
  const location = appState.employer_locations.find((item) => item.employer_id === lead.employer_id) || {};
  const contacts = appState.contacts
    .filter((item) => item.employer_id === lead.employer_id && !item.do_not_contact)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  return { lead, employer, job, location, contacts };
}

function filteredLeads() {
  const bucket = els.bucketFilter.value;
  const status = els.statusFilter.value;
  const query = els.searchInput.value.trim().toLowerCase();

  return appState.lead_scores.filter((lead) => {
    const { employer, job, location } = getLeadBundle(lead);
    if (bucket !== 'all' && lead.priority_bucket !== bucket) return false;
    if (status !== 'all' && lead.review_status !== status) return false;
    if (!query) return true;
    const haystack = [employer.legal_name, job.title, location.suburb, location.postcode, lead.priority_bucket]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function pillClass(value) {
  if (value === 'A' || value === 'P1' || value === 'S4' || value === 'S3') return 'green';
  if (value === 'B' || value === 'P2' || value === 'S2') return 'blue';
  if (value === 'C' || value === 'P3' || value === 'S1') return 'amber';
  return 'red';
}

function renderMetrics() {
  const leads = appState.lead_scores;
  els.metricTotal.textContent = String(leads.length);
  els.metricA.textContent = String(leads.filter((lead) => lead.priority_bucket === 'A').length);
  els.metricContact.textContent = String(leads.filter((lead) => lead.next_action === 'contact').length);
  els.metricRun.textContent = formatDate(appState.meta.last_daily_run_at || appState.meta.last_scored_at);
}

function renderSourcePolicies() {
  els.sourcePolicies.innerHTML = appState.source_policies.map((policy) => `
    <div class="source-item">
      <strong>${escapeHtml(policy.source_name)}</strong>
      <span>${escapeHtml(policy.allowed_method)}</span>
      <span>${escapeHtml(policy.tos_status)}</span>
    </div>
  `).join('');
}

function renderLeadList() {
  const leads = filteredLeads();
  if (!leads.length) {
    els.leadList.innerHTML = '<div class="empty-state">没有匹配结果</div>';
    return;
  }

  els.leadList.innerHTML = leads.map((lead) => {
    const { employer, job, location } = getLeadBundle(lead);
    const active = lead.lead_id === selectedLeadId ? ' active' : '';
    return `
      <article class="lead-row${active}" data-lead-id="${escapeHtml(lead.lead_id)}">
        <div class="score bucket-${escapeHtml(lead.priority_bucket)}">${lead.final_score}</div>
        <div class="lead-main">
          <div class="lead-title">${escapeHtml(employer.legal_name)}</div>
          <div class="lead-subtitle">${escapeHtml(job.title)} · ${escapeHtml(location.suburb || job.location_text)} ${escapeHtml(location.postcode || '')}</div>
        </div>
        <div class="pill-stack">
          <span class="pill ${pillClass(lead.priority_bucket)}">${escapeHtml(lead.priority_bucket)} 级</span>
          <span class="pill ${pillClass(lead.sponsorship_level)}">${escapeHtml(lead.sponsorship_level)}</span>
          <span class="pill ${pillClass(lead.priority_region_tier)}">${escapeHtml(lead.priority_region_tier)}</span>
        </div>
      </article>
    `;
  }).join('');

  els.leadList.querySelectorAll('.lead-row').forEach((row) => {
    row.addEventListener('click', () => {
      selectedLeadId = row.dataset.leadId;
      render();
    });
  });
}

function renderEvidence(label, items) {
  if (!items || !items.length) {
    return `<div class="evidence-item"><span>${escapeHtml(label)}</span>--</div>`;
  }
  return items.map((item) => `
    <div class="evidence-item"><span>${escapeHtml(label)}</span>${escapeHtml(item)}</div>
  `).join('');
}

function renderDetail() {
  const selected = appState.lead_scores.find((lead) => lead.lead_id === selectedLeadId);
  if (!selected) {
    els.detail.innerHTML = '<div class="empty-state">选择一条 lead</div>';
    return;
  }

  const { lead, employer, job, location, contacts } = getLeadBundle(selected);
  const bestContact = contacts[0] || {};
  const evidence = lead.evidence || {};
  const occupation = lead.occupation_match || {};
  const sourceLink = job.source_url ? `<a href="${escapeHtml(job.source_url)}" target="_blank" rel="noreferrer">来源链接</a>` : '<span class="muted">无来源链接</span>';

  els.detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">
        <div>
          <h3>${escapeHtml(employer.legal_name)}</h3>
          <p class="muted">${escapeHtml(job.title)} · ${escapeHtml(location.suburb || job.location_text)} ${escapeHtml(location.postcode || '')}</p>
        </div>
        <div class="score bucket-${escapeHtml(lead.priority_bucket)}">${lead.final_score}</div>
      </div>
      <div class="detail-meta">
        <span class="pill ${pillClass(lead.priority_bucket)}">${escapeHtml(lead.priority_bucket)} 级</span>
        <span class="pill ${pillClass(lead.sponsorship_level)}">${escapeHtml(lead.sponsorship_level)}</span>
        <span class="pill ${pillClass(lead.priority_region_tier)}">${escapeHtml(lead.priority_region_tier)}</span>
        <span class="pill ${lead.negative_sponsorship_flag ? 'red' : 'green'}">${lead.negative_sponsorship_flag ? '否定担保' : '无否定词'}</span>
      </div>
    </div>

    <div class="detail-body">
      <div class="review-actions">
        <button class="primary" data-review="queued" data-next="contact">加入外联</button>
        <button data-review="contacted" data-next="follow_up">标记已联系</button>
        <button data-review="paused" data-next="watch">暂缓</button>
        <button class="danger" data-review="rejected" data-next="discard">放弃</button>
      </div>

      <section>
        <div class="section-title">公司</div>
        <div class="info-grid">
          <div class="field"><span>ABN / ACN</span><strong>${escapeHtml(employer.abn || '--')} ${escapeHtml(employer.acn || '')}</strong></div>
          <div class="field"><span>状态</span><strong>${escapeHtml(employer.entity_status || '--')} · ${escapeHtml(employer.gst_status || '--')}</strong></div>
          <div class="field"><span>官网</span>${employer.website ? `<a href="${escapeHtml(employer.website)}" target="_blank" rel="noreferrer">${escapeHtml(employer.website)}</a>` : '<strong>--</strong>'}</div>
          <div class="field"><span>地区</span><strong>${escapeHtml(location.lga || '--')} · ${escapeHtml(location.rdv_region || '--')}</strong></div>
        </div>
      </section>

      <section>
        <div class="section-title">职位</div>
        <div class="info-grid">
          <div class="field"><span>职业匹配</span><strong>${escapeHtml(occupation.title || '--')} ${occupation.anzsco_code ? `· ${escapeHtml(occupation.anzsco_code)}` : ''}</strong></div>
          <div class="field"><span>来源</span><strong>${escapeHtml(job.source_name || '--')} · ${sourceLink}</strong></div>
          <div class="field"><span>薪资 / 类型</span><strong>${escapeHtml(job.salary_text || '--')}</strong></div>
          <div class="field"><span>发布时间</span><strong>${formatDate(job.posted_date || job.seen_date)}</strong></div>
        </div>
      </section>

      <section>
        <div class="section-title">联系方式</div>
        <div class="info-grid">
          <div class="field"><span>最佳联系方式</span><strong>${escapeHtml(bestContact.value || '--')}</strong></div>
          <div class="field"><span>类型 / 可信度</span><strong>${escapeHtml(bestContact.contact_type || '--')} · ${escapeHtml(bestContact.confidence || '--')}</strong></div>
        </div>
      </section>

      <section>
        <div class="section-title">证据</div>
        <div class="evidence-list">
          ${renderEvidence('中文', evidence.language)}
          ${renderEvidence('担保', evidence.sponsorship)}
          ${renderEvidence('职业', evidence.occupation)}
          ${renderEvidence('地区', evidence.region)}
          ${renderEvidence('联系', evidence.contact)}
        </div>
      </section>

      <section class="note-box">
        <div class="section-title">复核备注</div>
        <textarea id="review-note">${escapeHtml(lead.reviewer_notes || '')}</textarea>
        <button id="save-note">保存备注</button>
      </section>

      <section>
        <div class="section-title">活动</div>
        <div class="activity">
          ${(appState.activity || []).slice(0, 6).map((item) => `
            <div class="activity-row">
              <span>${formatDate(item.timestamp)}</span>
              <strong>${escapeHtml(item.message)}</strong>
            </div>
          `).join('')}
        </div>
      </section>
    </div>
  `;

  els.detail.querySelectorAll('[data-review]').forEach((button) => {
    button.addEventListener('click', () => {
      runAction('review-lead', {
        lead_id: lead.lead_id,
        review_status: button.dataset.review,
        next_action: button.dataset.next,
        reviewer_notes: document.querySelector('#review-note')?.value || lead.reviewer_notes || ''
      }).catch(showError);
    });
  });

  els.detail.querySelector('#save-note').addEventListener('click', () => {
    runAction('review-lead', {
      lead_id: lead.lead_id,
      reviewer_notes: document.querySelector('#review-note').value
    }).catch(showError);
  });
}

function render() {
  if (!appState) return;
  renderMetrics();
  renderSourcePolicies();
  renderLeadList();
  renderDetail();
}

function showError(error) {
  console.error(error);
  els.statusLine.textContent = error.message || '操作失败';
}

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    runAction(button.dataset.action).catch(showError);
  });
});

[els.bucketFilter, els.statusFilter, els.searchInput].forEach((control) => {
  control.addEventListener('input', render);
});

els.importButton.addEventListener('click', async () => {
  const file = els.seedFile.files[0];
  if (!file) {
    els.statusLine.textContent = '请选择CSV';
    return;
  }
  const text = await file.text();
  const rows = csvParse(text);
  runAction('import-seeds', { rows }).catch(showError);
});

els.exportButton.addEventListener('click', () => {
  exportCsv().catch(showError);
});

loadState().catch(showError);
