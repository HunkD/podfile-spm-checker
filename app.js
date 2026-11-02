import { parsePodfileLock, scanPods, STATUSES } from './lib.js';

const CACHE_KEY = 'podfile-spm-checker:cache:v1';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 6;

const $ = (id) => document.getElementById(id);

const ui = {
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  pasteArea: $('pasteArea'),
  scanPaste: $('scanPaste'),
  loadSample: $('loadSample'),
  errorBox: $('errorBox'),
  results: $('results'),
  summary: $('summary'),
  progressWrap: $('progressWrap'),
  progressBar: $('progressBar'),
  scanStatus: $('scanStatus'),
  search: $('search'),
  statusFilter: $('statusFilter'),
  exportJson: $('exportJson'),
  exportCsv: $('exportCsv'),
  copyMd: $('copyMd'),
  tbody: $('tbody'),
  emptyState: $('emptyState'),
  clearCache: $('clearCache'),
  toast: $('toast'),
};

const state = {
  sourceName: '',
  pods: [],
  results: [],
  done: 0,
  scanning: false,
  startedAt: 0,
};

let scanToken = 0;
let toastTimer = 0;

const GROUP = {
  ready: 'ready',
  'added-later': 'added-later',
  'no-spm': 'no-spm',
  'non-github': 'unresolved',
  'no-podspec': 'unresolved',
  'no-version': 'unresolved',
  error: 'unresolved',
};

const SAMPLE_LOCK = `PODS:
  - AFNetworking (4.0.1):
    - AFNetworking/NSURLSession (= 4.0.1)
    - AFNetworking/Reachability (= 4.0.1)
  - AFNetworking/NSURLSession (4.0.1):
    - AFNetworking/Reachability
  - Alamofire (5.6.4)
  - Firebase/CoreOnly (10.28.0):
    - FirebaseCore (= 10.28.0)
  - Kingfisher (7.4.1)
  - MyCompanyUI (2.3.1)
  - SDWebImage (5.15.5)
  - SnapKit (5.6.0)

DEPENDENCIES:
  - AFNetworking (~> 4.0)
  - Alamofire (~> 5.6)
  - Firebase/CoreOnly
  - Kingfisher (~> 7.0)
  - MyCompanyUI (from \`../MyCompanyUI\`)
  - SDWebImage (~> 5.0)
  - SnapKit (~> 5.0)

SPEC CHECKSUMS:
  Alamofire: 4e95d97098eacb88856099c4fc79b526a299e48c
`;

/* ------------------------------ Cache ------------------------------ */

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Private browsing or quota exceeded: caching is optional.
  }
}

const cacheKey = (pod) => `${pod.root}@${pod.version}`;

/* ----------------------------- Rendering ----------------------------- */

function counts() {
  const c = { total: state.pods.length, ready: 0, 'added-later': 0, 'no-spm': 0, unresolved: 0 };
  for (const r of state.results) {
    if (!r) continue;
    const group = GROUP[r.status] ?? 'unresolved';
    c[group] += 1;
  }
  return c;
}

function renderSummary() {
  const c = counts();
  const stats = [
    ['Pods', c.total, ''],
    ['SPM ready', c.ready, 'good'],
    ['SPM added later', c['added-later'], 'warn'],
    ['No Package.swift', c['no-spm'], 'warn'],
    ['Unresolved', c.unresolved, ''],
  ];
  const frag = document.createDocumentFragment();
  for (const [label, value, tone] of stats) {
    const card = document.createElement('div');
    card.className = `stat ${tone}`.trim();
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = String(value);
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = label;
    card.append(v, l);
    frag.appendChild(card);
  }
  ui.summary.replaceChildren(frag);
}

function renderProgress() {
  const total = state.pods.length;
  const pct = total ? Math.round((state.done / total) * 100) : 0;
  ui.progressBar.style.width = `${pct}%`;
  ui.progressWrap.setAttribute('aria-valuenow', String(pct));
  ui.progressWrap.parentElement.classList.toggle('done', !state.scanning && total > 0);

  if (state.scanning) {
    ui.scanStatus.textContent = `Checking ${state.done}/${total} pods…`;
  } else if (total) {
    const seconds = ((Date.now() - state.startedAt) / 1000).toFixed(1);
    ui.scanStatus.textContent = `Checked ${total} pods in ${seconds}s`;
  } else {
    ui.scanStatus.textContent = '';
  }
}

function matchQuery(pod, result, query) {
  const hay = [
    pod.root,
    pod.version,
    ...(pod.subspecs ?? []),
    result?.status,
    STATUSES[result?.status]?.label,
    result?.tag,
    result?.sourceUrl,
    result?.detail,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(query);
}

function buildRow(pod, result) {
  const tr = document.createElement('tr');

  // Pod
  const podTd = document.createElement('td');
  const podCell = document.createElement('div');
  podCell.className = 'pod-cell';
  const name = document.createElement('span');
  name.className = 'pod-name';
  name.textContent = pod.root;
  podCell.appendChild(name);

  const meta = document.createElement('span');
  meta.className = 'pod-meta';
  if (pod.direct) {
    const direct = document.createElement('span');
    direct.className = 'tag direct';
    direct.textContent = 'direct';
    meta.appendChild(direct);
  }
  if (pod.subspecs?.length) {
    const subspec = document.createElement('span');
    subspec.textContent = `+${pod.subspecs.length} subspec${pod.subspecs.length === 1 ? '' : 's'}`;
    subspec.title = pod.subspecs.join(', ');
    meta.appendChild(subspec);
  }
  if (!pod.hasRootEntry) {
    const note = document.createElement('span');
    note.textContent = 'root not pinned';
    note.title = 'Only subspecs of this pod appear in PODS';
    meta.appendChild(note);
  }
  if (meta.childNodes.length) podCell.appendChild(meta);
  podTd.appendChild(podCell);
  tr.appendChild(podTd);

  // Version
  const versionTd = document.createElement('td');
  versionTd.className = 'version';
  versionTd.textContent = pod.version ?? '—';
  tr.appendChild(versionTd);

  // Status
  const statusTd = document.createElement('td');
  const badge = document.createElement('span');
  if (result) {
    const metaInfo = STATUSES[result.status] ?? { label: result.status, tone: 'muted' };
    badge.className = `badge ${metaInfo.tone}`;
    badge.textContent = metaInfo.label;
    if (result.detail) badge.title = result.detail;
    if (result.cached) badge.title = `${badge.title}\n(cached)`.trim();
  } else {
    badge.className = 'badge pending';
    badge.textContent = 'Checking…';
  }
  statusTd.appendChild(badge);
  tr.appendChild(statusTd);

  // Matched tag
  const tagTd = document.createElement('td');
  tagTd.className = 'tag-cell';
  tagTd.textContent = result?.tag ?? '—';
  tr.appendChild(tagTd);

  // Repository
  const repoTd = document.createElement('td');
  if (result?.sourceUrl) {
    const a = document.createElement('a');
    a.href = result.sourceUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = result.sourceUrl.replace(/^https?:\/\/(www\.)?/, '');
    a.title = result.sourceUrl;
    repoTd.appendChild(a);
  } else {
    repoTd.textContent = '—';
  }
  tr.appendChild(repoTd);

  // Notes
  const notesTd = document.createElement('td');
  notesTd.className = 'notes';
  let note = result?.detail ?? '';
  if (result?.status === 'ready') {
    note = result.toolsVersion
      ? `Package.swift (swift-tools-version ${result.toolsVersion})`
      : 'Package.swift found at tag';
  }
  if (!result) note = 'Resolving podspec…';
  const noteSpan = document.createElement('span');
  noteSpan.className = 'notes-text';
  noteSpan.textContent = note;
  noteSpan.title = note;
  notesTd.appendChild(noteSpan);
  tr.appendChild(notesTd);

  return tr;
}

function renderRows() {
  const query = ui.search.value.trim().toLowerCase();
  const filter = ui.statusFilter.value;
  const frag = document.createDocumentFragment();
  let shown = 0;

  state.pods.forEach((pod, i) => {
    const result = state.results[i];
    if (filter !== 'all') {
      if (!result) return;
      const group = GROUP[result.status] ?? 'unresolved';
      if (group !== filter && result.status !== filter) return;
    }
    if (query && !matchQuery(pod, result, query)) return;
    frag.appendChild(buildRow(pod, result));
    shown += 1;
  });

  ui.tbody.replaceChildren(frag);
  ui.emptyState.hidden = shown !== 0;
}

function render() {
  renderSummary();
  renderProgress();
  renderRows();
  const finished = !state.scanning && state.pods.length > 0;
  ui.exportJson.disabled = !finished;
  ui.exportCsv.disabled = !finished;
  ui.copyMd.disabled = !finished;
}

/* ------------------------------ Scan ------------------------------ */

function showError(message) {
  ui.errorBox.textContent = message;
  ui.errorBox.hidden = false;
}

function hideError() {
  ui.errorBox.hidden = true;
  ui.errorBox.textContent = '';
}

async function startScan(text, sourceName) {
  hideError();

  const parsed = parsePodfileLock(text);
  if (!parsed.pods.length) {
    showError('No PODS section found. Paste the full contents of a Podfile.lock (not a Podfile).');
    return;
  }

  const token = ++scanToken;
  state.sourceName = sourceName;
  state.pods = parsed.pods;
  state.results = new Array(parsed.pods.length);
  state.done = 0;
  state.scanning = true;
  state.startedAt = Date.now();

  ui.search.value = '';
  ui.statusFilter.value = 'all';
  ui.results.hidden = false;
  render();
  ui.results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const cache = readCache();
  const pending = [];
  for (let i = 0; i < state.pods.length; i++) {
    const pod = state.pods[i];
    const hit = cache[cacheKey(pod)];
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      state.results[i] = { ...hit.result, cached: true };
      state.done += 1;
    } else {
      pending.push({ pod, index: i });
    }
  }
  render();

  let cacheChanged = false;

  try {
    await scanPods(fetch, pending.map((p) => p.pod), {
      concurrency: CONCURRENCY,
      onResult: (result, j) => {
        if (token !== scanToken) return;
        const { pod, index } = pending[j];
        state.results[index] = result;
        state.done += 1;
        cache[cacheKey(pod)] = { at: Date.now(), result };
        cacheChanged = true;
        render();
      },
    });
  } catch (err) {
    if (token === scanToken) showError(`Scan failed: ${err.message}`);
  }

  if (token !== scanToken) return;
  if (cacheChanged) writeCache(cache);
  state.scanning = false;
  render();
  toast(`Checked ${state.pods.length} pods`);
}

async function handleFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    await startScan(text, file.name);
  } catch (err) {
    showError(`Could not read ${file.name}: ${err.message}`);
  }
}

/* ----------------------------- Exports ----------------------------- */

function buildReport() {
  return {
    source: state.sourceName,
    generatedAt: new Date().toISOString(),
    summary: counts(),
    pods: state.results.filter(Boolean).map((r) => ({
      name: r.name,
      version: r.version,
      direct: Boolean(r.direct),
      subspecs: r.subspecs ?? [],
      status: r.status,
      matchedTag: r.tag ?? null,
      repository: r.sourceUrl ?? null,
      packageSwift: r.packageUrl ?? null,
      toolsVersion: r.toolsVersion ?? null,
      detail: r.detail ?? null,
    })),
  };
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  download('spm-check.json', JSON.stringify(buildReport(), null, 2), 'application/json');
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function exportCsv() {
  const rows = [['pod', 'version', 'status', 'matchedTag', 'repository', 'toolsVersion', 'detail']];
  for (const r of state.results.filter(Boolean)) {
    rows.push([r.name, r.version, r.status, r.tag, r.sourceUrl, r.toolsVersion, r.detail]);
  }
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  download('spm-check.csv', `${csv}\r\n`, 'text/csv');
}

function markdownReport() {
  const label = (r) => STATUSES[r.status]?.label ?? r.status;
  const lines = [
    '# Podfile → SPM compatibility',
    '',
    `Source: ${state.sourceName || 'pasted Podfile.lock'}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    '| Pod | Version | Status | Matched tag | Repository | Notes |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of state.results.filter(Boolean)) {
    const cell = (v) => String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
    lines.push(`| ${[r.name, r.version, label(r), r.tag, r.sourceUrl, r.detail].map(cell).join(' | ')} |`);
  }
  return lines.join('\n');
}

async function copyMarkdown() {
  const md = markdownReport();
  try {
    await navigator.clipboard.writeText(md);
    toast('Markdown copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = md;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Markdown copied');
  }
}

/* ------------------------------ UI wiring ------------------------------ */

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2200);
}

ui.dropzone.addEventListener('click', () => ui.fileInput.click());
ui.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    ui.fileInput.click();
  }
});

for (const type of ['dragenter', 'dragover']) {
  ui.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    ui.dropzone.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  ui.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    ui.dropzone.classList.remove('dragover');
  });
}
ui.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files?.[0];
  if (file) handleFile(file);
  ui.fileInput.value = '';
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

ui.scanPaste.addEventListener('click', () => {
  const text = ui.pasteArea.value;
  if (!text.trim()) {
    showError('Paste a Podfile.lock first, or drop a file above.');
    return;
  }
  startScan(text, 'pasted Podfile.lock');
});

ui.loadSample.addEventListener('click', () => {
  ui.pasteArea.value = SAMPLE_LOCK;
  ui.pasteArea.closest('details').open = true;
  startScan(SAMPLE_LOCK, 'Sample Podfile.lock');
});

ui.search.addEventListener('input', renderRows);
ui.statusFilter.addEventListener('change', renderRows);
ui.exportJson.addEventListener('click', exportJson);
ui.exportCsv.addEventListener('click', exportCsv);
ui.copyMd.addEventListener('click', copyMarkdown);
ui.clearCache.addEventListener('click', () => {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
  toast('Cache cleared');
});
