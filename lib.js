// Pure logic for podfile-spm-checker. No DOM access so it can be tested in Node.

const SPEC_CDN = 'https://cdn.jsdelivr.net/cocoa/Specs';
const RAW = 'https://raw.githubusercontent.com';

// Hosts with a public, CORS-enabled way to read a file at a ref.
// Self-hosted GitLab/Gitea instances are deliberately absent: the browser
// cannot read them unless that instance sets CORS headers.
const HOST_KINDS = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'gitee.com': 'gitee',
  'codeberg.org': 'gitea',
  'gitea.com': 'gitea',
};

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

/** A URL that returns the raw text of `Package.swift` for a normalized repo. */
export function packageSwiftUrl(repo, ref) {
  const refPath = encodeURIComponent(ref).replace(/%2F/g, '/');
  switch (repo.kind) {
    case 'github':
      return `${RAW}/${repo.path}/${refPath}/Package.swift`;
    case 'gitlab':
      // The raw web endpoint (/-/raw/) does not send CORS headers, but the
      // public API does.
      return `https://${repo.host}/api/v4/projects/${encodeURIComponent(repo.path)}` +
        `/repository/files/Package.swift/raw?ref=${encodeURIComponent(ref)}`;
    case 'bitbucket':
      return `https://api.bitbucket.org/2.0/repositories/${repo.path}` +
        `/src/${refPath}/Package.swift`;
    case 'gitea':
      return `https://${repo.host}/api/v1/repos/${repo.path}/raw/Package.swift` +
        `?ref=${encodeURIComponent(ref)}`;
    case 'gitee':
      // Gitee's contents API returns 200 with [] for a missing file, so the
      // response body has to be checked as well.
      return `https://${repo.host}/api/v5/repos/${repo.path}/contents/Package.swift` +
        `?ref=${encodeURIComponent(ref)}`;
    default:
      return `https://${repo.host}/${repo.path}/raw/${refPath}/Package.swift`;
  }
}

/**
 * Repositories that commonly hold SPM support for a CocoaPods project that
 * keeps its package manifest outside the CocoaPods repo.
 */
const SEPARATE_REPO_NAMES = [
  (name) => `${name}-spm`,
  (name) => `${name}-swiftpm`,
  (name) => `${name}-swift-package`,
  (name) => `swift-package-manager-${name}`,
];

export function spmRepoCandidates(repo) {
  const dir = repo.path.split('/').slice(0, -1);
  return SEPARATE_REPO_NAMES.map((makeName) => {
    const name = makeName(repo.name);
    const path = [...dir, name].join('/');
    return {
      ...repo,
      path,
      repo: path.split('/').slice(1).join('/'),
      name,
      url: `https://${repo.host}/${path}`,
    };
  });
}

/**
 * Parse user-supplied `PodName = repository` overrides.
 * Bare `owner/repo` values are treated as GitHub repositories.
 */
export function parseOverrides(text) {
  const map = new Map();
  if (!text) return map;
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`Override line ${i + 1}: expected "PodName = repository URL"`);
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!name || !value) throw new Error(`Override line ${i + 1}: empty pod name or repository`);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^[^@/]+@/.test(value) && !value.includes(':')) {
      value = `https://github.com/${value}`;
    }
    map.set(name, value);
  });
  return map;
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

/**
 * Normalize the many forms of a podspec `source.git` into host/owner/repo.
 * `path` keeps GitLab subgroups ("group/sub/project"); `name` is the last segment.
 */
export function normalizeGitUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const u = input.trim().replace(/^git\+/, '');

  let host, path;
  let m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (m) {
    host = m[1];
    path = m[2];
  } else {
    // scp-like: git@github.com:owner/repo.git
    m = u.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!m) return null;
    host = m[1];
    path = m[2];
  }

  host = host.toLowerCase().replace(/^www\./, '');
  path = path
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const segments = path.split('/').filter(Boolean);
  if (!host || segments.length < 2) return null;

  segments[0] = segments[0].replace(/^~/, '');
  const cleanPath = segments.join('/');
  const owner = segments[0];
  const repo = segments.slice(1).join('/');
  const name = segments[segments.length - 1];
  return {
    host,
    path: cleanPath,
    owner,
    repo,
    name,
    kind: HOST_KINDS[host] ?? 'unknown',
    url: `https://${host}/${cleanPath}`,
  };
}

/**
 * Infer the source repository from a binary podspec `source.http` URL.
 * Binary pods often publish a zip/tarball as a GitHub release asset or archive,
 * even though the podspec has no `source.git` (e.g. BrazeKit).
 */
export function repoFromBinaryUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const m = input.trim().match(/^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/(?:releases|archive)\//i);
  if (!m) return null;
  return normalizeGitUrl(`https://github.com/${m[1]}/${m[2].replace(/\.git$/i, '')}`);
}

/** Search URL for pods with no resolvable git repository. */
export function swiftPackageIndexUrl(name) {
  return `https://swiftpackageindex.com/search?query=${encodeURIComponent(name)}`;
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

function decodeBase64Utf8(base64) {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Fetch Package.swift, normalizing host-specific responses (Gitee returns JSON). */
async function fetchPackageSwift(fetchImpl, repo, ref) {
  const res = await probe(fetchImpl, packageSwiftUrl(repo, ref));
  if (!res.ok || repo.kind !== 'gitee') return res;

  try {
    const data = JSON.parse(res.text);
    if (!data || Array.isArray(data) || data.type !== 'file') return { ok: false, status: 404 };
    return { ok: true, text: decodeBase64Utf8(data.content ?? '') };
  } catch {
    return { ok: false, error: new Error('Unexpected Gitee API response') };
  }
}

/** Probe a repo at each ref; returns the first hit, or the last network error. */
async function probeRefs(fetchImpl, repo, refs) {
  let networkError = null;
  for (const ref of refs) {
    const res = await fetchPackageSwift(fetchImpl, repo, ref);
    if (res.ok) return { ref, text: res.text };
    if (res.error) networkError = res.error;
  }
  return { networkError };
}

/**
 * Resolve one pod: podspec -> git repo -> Package.swift at the matching tag.
 * Statuses: ready | added-later | spm-repo | no-spm | non-git | unverified |
 *           no-podspec | no-version | error
 *
 * `override` forces the repository to probe. It is the escape hatch for pods
 * whose SPM package lives in another repo (or on a host the browser cannot read).
 */
export async function scanPod(
  fetchImpl,
  pod,
  { defaultBranches = ['main', 'master'], override = null } = {},
) {
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
  const podRepo = git ? normalizeGitUrl(git) : null;
  // Binary pods can still ship SPM from the repo their release asset came from.
  const inferredRepo = git ? null : repoFromBinaryUrl(spec?.source?.http);
  if (podRepo) base.podRepoUrl = podRepo.url;
  else if (inferredRepo) {
    base.podRepoUrl = inferredRepo.url;
    base.inferredFrom = spec.source.http;
  }

  let repo = null;
  const overridden = Boolean(override);
  if (overridden) {
    repo = normalizeGitUrl(override);
    if (!repo) {
      return { ...base, status: 'error', detail: `Invalid override repository: ${override}` };
    }
    // Allow "gitlab+https://host/group/project" to force an adapter on a
    // self-hosted instance that exposes CORS.
    const kindHint = override.match(/^(github|gitlab|bitbucket|gitea|gitee)\+/i)?.[1]?.toLowerCase();
    if (kindHint) repo = { ...repo, kind: kindHint };
    base.overridden = true;
  } else if (!git && !inferredRepo) {
    return {
      ...base,
      status: 'non-git',
      detail: 'Podspec has no git source (binary or non-git distribution); check the vendor for an SPM package',
    };
  } else if (!git) {
    repo = inferredRepo;
  } else if (!podRepo) {
    return { ...base, status: 'unverified', detail: `Unrecognized git URL: ${git}` };
  } else {
    repo = podRepo;
  }

  if (repo.kind === 'unknown') {
    return {
      ...base,
      status: 'unverified',
      detail: `Hosted on ${repo.host}, which has no CORS-enabled file API. Open ${repo.url} or add an override.`,
    };
  }

  base.sourceUrl = repo.url;
  base.sourceTag = spec?.source?.tag ?? null;
  const tags = tagCandidates(pod.root, pod.version, base.sourceTag);

  const tagHit = await probeRefs(fetchImpl, repo, tags);
  if (tagHit.ref) {
    return {
      ...base,
      status: 'ready',
      tag: tagHit.ref,
      packageUrl: packageSwiftUrl(repo, tagHit.ref),
      toolsVersion: toolsVersion(tagHit.text),
    };
  }
  if (tagHit.networkError) {
    return { ...base, status: 'error', detail: `${repo.host} fetch failed: ${tagHit.networkError.message}` };
  }

  const branchHit = await probeRefs(fetchImpl, repo, defaultBranches);
  if (branchHit.ref) {
    return {
      ...base,
      status: 'added-later',
      tag: branchHit.ref,
      packageUrl: packageSwiftUrl(repo, branchHit.ref),
      detail: `Package.swift exists on ${branchHit.ref} but not at tag ${pod.version} (SPM support added after this release)`,
    };
  }
  if (branchHit.networkError) {
    return { ...base, status: 'error', detail: `${repo.host} fetch failed: ${branchHit.networkError.message}` };
  }

  // No manifest in the CocoaPods repo: look for the common "separate SPM repo"
  // pattern (e.g. aws-sdk-ios -> aws-sdk-ios-spm). The verdict stays manual
  // because release lines in the two repos may not line up.
  if (!overridden) {
    for (const candidate of spmRepoCandidates(repo)) {
      const candidateHit = await probeRefs(fetchImpl, candidate, defaultBranches);
      if (!candidateHit.ref) continue;
      const candidateTag = await probeRefs(fetchImpl, candidate, tags);
      const ref = candidateTag.ref ?? candidateHit.ref;
      return {
        ...base,
        status: 'spm-repo',
        sourceUrl: candidate.url,
        tag: ref,
        packageUrl: packageSwiftUrl(candidate, ref),
        detail: `Package.swift found in separate repository ${candidate.url} at ${ref}; confirm it matches version ${pod.version}`,
      };
    }
  }

  return {
    ...base,
    status: 'no-spm',
    detail: `No Package.swift at any tag candidate (${tags.join(', ')}) or on ${defaultBranches.join('/')}`,
  };
}

/** Run scans with bounded concurrency; onResult fires as each pod finishes. */
export async function scanPods(fetchImpl, pods, { concurrency = 6, onResult, overrides } = {}) {
  const queue = [...pods];
  const results = new Array(pods.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < pods.length) {
      const index = nextIndex++;
      const result = await scanPod(fetchImpl, queue[index], {
        override: overrides?.get(queue[index].root) ?? null,
      });
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
  'spm-repo': { label: 'SPM in other repo', tone: 'warn' },
  'no-spm': { label: 'No Package.swift', tone: 'warn' },
  'non-git': { label: 'No git repo', tone: 'muted' },
  unverified: { label: 'Host not checked', tone: 'muted' },
  'no-podspec': { label: 'Podspec not found', tone: 'muted' },
  'no-version': { label: 'No version', tone: 'muted' },
  error: { label: 'Check failed', tone: 'bad' },
};
