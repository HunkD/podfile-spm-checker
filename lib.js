// Pure logic for podfile-spm-checker. No DOM access so it can be tested in Node.

const SPEC_CDN = 'https://cdn.jsdelivr.net/cocoa/Specs';
const RAW = 'https://raw.githubusercontent.com';

/* ------------------------------- MD5 ------------------------------- */

const SHIFT = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

/** Hex MD5 of a UTF-8 string. Needed for the CocoaPods CDN shard path. */
export function md5(str) {
  const msg = new TextEncoder().encode(str);
  const len = msg.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;

  const view = new DataView(buf.buffer);
  const bits = len * 8;
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 0x100000000) >>> 0, true);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);

    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }

      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const s = SHIFT[(i >> 4) * 4 + (i & 3)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a, true);
  outView.setUint32(4, b, true);
  outView.setUint32(8, c, true);
  outView.setUint32(12, d, true);
  return [...out].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* --------------------------- CocoaPods URLs --------------------------- */

/** Trunk shards spec files by the first three hex digits of md5(pod name). */
export function shardPath(podName) {
  const h = md5(podName);
  return `${h[0]}/${h[1]}/${h[2]}`;
}

export function podspecUrl(name, version) {
  return `${SPEC_CDN}/${shardPath(name)}/${encodeURIComponent(name)}/` +
    `${encodeURIComponent(version)}/${encodeURIComponent(name)}.podspec.json`;
}

export function rawFileUrl(owner, repo, ref, path) {
  return `${RAW}/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, '/')}/${path}`;
}

/* ---------------------------- Podfile.lock ---------------------------- */

/**
 * Parse the PODS and DEPENDENCIES sections of a Podfile.lock.
 * Root pods are matched at exactly two spaces of indentation; deeper lines are
 * dependency edges between pods and are ignored.
 */
export function parsePodfileLock(text) {
  const pods = new Map();
  const directRoots = new Set();
  let section = null;

  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^([A-Z][A-Z0-9 _]*):\s*$/);
    if (header) {
      section = header[1];
      continue;
    }

    if (section === 'PODS') {
      const m = line.match(/^ {2}- ([^\s(]+) \(([^)]+)\)/);
      if (!m) continue;
      const fullName = m[1];
      // Local/external pods can sit in PODS without a semver version.
      const version = /^[0-9][0-9A-Za-z.+-]*$/.test(m[2].trim()) ? m[2].trim() : null;
      const [root, ...rest] = fullName.split('/');
      const record = pods.get(root) ?? {
        root,
        version,
        subspecs: new Set(),
        hasRootEntry: false,
      };
      if (!record.version) record.version = version;
      if (rest.length) record.subspecs.add(rest.join('/'));
      else record.hasRootEntry = true;
      pods.set(root, record);
    } else if (section === 'DEPENDENCIES') {
      const m = line.match(/^ {2}- ([^\s(]+)/);
      if (m) directRoots.add(m[1].split('/')[0]);
    }
  }

  const list = [...pods.values()].map((p) => ({
    root: p.root,
    version: p.version,
    subspecs: [...p.subspecs].sort(),
    hasRootEntry: p.hasRootEntry,
    direct: directRoots.has(p.root),
  }));

  return { pods: list, directRoots: [...directRoots] };
}

/* ------------------------------- Git URLs ------------------------------- */

/** Normalize the many forms of a podspec `source.git` into host/owner/repo. */
export function normalizeGitUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let u = input.trim().replace(/^git\+/, '');

  let host, owner, repo;
  let m = u.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/(.+)$/i);
  if (m) {
    host = m[1];
    owner = m[2];
    repo = m[3];
  } else {
    // scp-like: git@github.com:owner/repo.git
    m = u.match(/^(?:[^@/]+@)?([^:/]+):([^/]+)\/(.+)$/);
    if (!m) return null;
    host = m[1];
    owner = m[2];
    repo = m[3];
  }

  repo = repo.replace(/\/+$/, '').replace(/\.git$/i, '');
  owner = owner.replace(/^~/, '');
  if (!host || !owner || !repo) return null;
  return { host: host.toLowerCase(), owner, repo, url: `https://${host}/${owner}/${repo}` };
}

/* ------------------------------ Probing ------------------------------ */

/** Tag spellings to try when the podspec does not pin an exact tag. */
export function tagCandidates(podName, version, sourceTag) {
  const out = [];
  const add = (v) => { if (v && !out.includes(v)) out.push(v); };
  add(sourceTag);
  add(version);
  add(`v${version}`);
  add(`${podName}-${version}`);
  add(`${podName}-v${version}`);
  add(`v${podName}-${version}`);
  add(`${podName}/${version}`);
  return out;
}

function toolsVersion(packageSwift) {
  const m = packageSwift.match(/swift-tools-version:\s*([\w.+-]+)/);
  return m ? m[1] : null;
}

const REQUEST_TIMEOUT_MS = 12000;

function fetchWithTimeout(fetchImpl, url) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
  // Older Safari: AbortSignal.timeout is missing.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetchImpl(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Fetch with a timeout and one retry on network/5xx/429 failures. */
async function probe(fetchImpl, url, { retries = 1 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(fetchImpl, url);
      if (res.ok) return { ok: true, text: await res.text() };
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      return { ok: false, status: res.status };
    } catch (err) {
      lastError = err;
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Resolve one pod: podspec -> git repo -> Package.swift at the matching tag.
 * Statuses: ready | added-later | no-spm | non-github | no-podspec | error
 */
export async function scanPod(fetchImpl, pod, { defaultBranches = ['main', 'master'] } = {}) {
  const base = {
    name: pod.root,
    version: pod.version,
    subspecs: pod.subspecs,
    hasRootEntry: pod.hasRootEntry,
    direct: pod.direct,
  };

  if (!pod.version) {
    return { ...base, status: 'no-version', detail: 'No resolvable version in Podfile.lock (local or external pod)' };
  }

  const specRes = await probe(fetchImpl, podspecUrl(pod.root, pod.version));
  if (specRes.error) {
    return { ...base, status: 'error', detail: `Podspec fetch failed: ${specRes.error.message}` };
  }
  if (!specRes.ok) {
    return { ...base, status: 'no-podspec', detail: `No podspec on the CocoaPods CDN (HTTP ${specRes.status})` };
  }

  let spec;
  try {
    spec = JSON.parse(specRes.text);
  } catch {
    return { ...base, status: 'error', detail: 'Podspec was not valid JSON' };
  }

  const git = spec?.source?.git;
  if (!git) {
    return { ...base, status: 'non-github', detail: 'Podspec declares no git source' };
  }

  const repo = normalizeGitUrl(git);
  if (!repo) {
    return { ...base, status: 'non-github', detail: `Unrecognized git URL: ${git}` };
  }
  base.sourceUrl = repo.url;
  base.sourceTag = spec?.source?.tag ?? null;

  if (repo.host !== 'github.com') {
    return { ...base, status: 'non-github', detail: `Hosted on ${repo.host}, not GitHub` };
  }

  const tags = tagCandidates(pod.root, pod.version, base.sourceTag);
  let networkError = null;

  for (const tag of tags) {
    const url = rawFileUrl(repo.owner, repo.repo, tag, 'Package.swift');
    const res = await probe(fetchImpl, url);
    if (res.ok) {
      return {
        ...base,
        status: 'ready',
        tag,
        packageUrl: url,
        toolsVersion: toolsVersion(res.text),
      };
    }
    if (res.error) networkError = res.error;
  }

  if (networkError) {
    return { ...base, status: 'error', detail: `GitHub raw fetch failed: ${networkError.message}` };
  }

  for (const branch of defaultBranches) {
    const url = rawFileUrl(repo.owner, repo.repo, branch, 'Package.swift');
    const res = await probe(fetchImpl, url);
    if (res.ok) {
      return {
        ...base,
        status: 'added-later',
        tag: branch,
        packageUrl: url,
        detail: `Package.swift exists on ${branch} but not at tag ${pod.version} (SPM support added after this release)`,
      };
    }
  }

  return {
    ...base,
    status: 'no-spm',
    detail: `No Package.swift at any tag candidate (${tags.join(', ')}) or on main/master`,
  };
}

/** Run scans with bounded concurrency; onResult fires as each pod finishes. */
export async function scanPods(fetchImpl, pods, { concurrency = 6, onResult } = {}) {
  const queue = [...pods];
  const results = new Array(pods.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < pods.length) {
      const index = nextIndex++;
      const result = await scanPod(fetchImpl, queue[index]);
      results[index] = result;
      onResult?.(result, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pods.length) }, worker));
  return results;
}

export const STATUSES = {
  ready: { label: 'SPM ready', tone: 'good' },
  'added-later': { label: 'SPM added later', tone: 'warn' },
  'no-spm': { label: 'No Package.swift', tone: 'warn' },
  'non-github': { label: 'Not GitHub', tone: 'muted' },
  'no-podspec': { label: 'Podspec not found', tone: 'muted' },
  'no-version': { label: 'No version', tone: 'muted' },
  error: { label: 'Check failed', tone: 'bad' },
};
