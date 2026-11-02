import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  md5, shardPath, podspecUrl, rawFileUrl,
  parsePodfileLock, normalizeGitUrl, tagCandidates, scanPod, scanPods,
} from '../lib.js';

const ok = (body) => ({ ok: true, status: 200, text: async () => body });
const notFound = () => ({ ok: false, status: 404, text: async () => '' });
const specBody = (source) => JSON.stringify({ name: 'Pod', source });

test('md5 matches node crypto', () => {
  for (const s of ['', 'abc', 'Alamofire', 'pödükt', 'a'.repeat(1000)]) {
    assert.equal(md5(s), crypto.createHash('md5').update(s).digest('hex'), s);
  }
});

test('shard path uses first three hex digits', () => {
  assert.equal(shardPath('Alamofire'), 'd/a/2');
  assert.equal(shardPath('SnapKit'), '1/f/6');
  assert.equal(shardPath('Firebase'), '0/3/5');
});

test('podspec and raw urls', () => {
  assert.equal(
    podspecUrl('Alamofire', '5.6.4'),
    'https://cdn.jsdelivr.net/cocoa/Specs/d/a/2/Alamofire/5.6.4/Alamofire.podspec.json',
  );
  assert.equal(
    rawFileUrl('firebase', 'firebase-ios-sdk', 'CocoaPods-10.28.0', 'Package.swift'),
    'https://raw.githubusercontent.com/firebase/firebase-ios-sdk/CocoaPods-10.28.0/Package.swift',
  );
});

test('normalizeGitUrl handles common forms', () => {
  const expected = { host: 'github.com', owner: 'onevcat', repo: 'Kingfisher' };
  for (const url of [
    'https://github.com/onevcat/Kingfisher.git',
    'https://github.com/onevcat/Kingfisher',
    'git@github.com:onevcat/Kingfisher.git',
    'ssh://git@github.com/onevcat/Kingfisher.git',
    'git://github.com/onevcat/Kingfisher.git',
    'git+https://github.com/onevcat/Kingfisher.git',
  ]) {
    const parsed = normalizeGitUrl(url);
    assert.deepEqual(
      { host: parsed.host, owner: parsed.owner, repo: parsed.repo },
      expected,
      url,
    );
  }
  assert.equal(normalizeGitUrl('https://gitlab.com/a/b.git').host, 'gitlab.com');
  assert.equal(normalizeGitUrl('not a url'), null);
  assert.equal(normalizeGitUrl(''), null);
});

test('tag candidates prefer the podspec tag and dedupe', () => {
  assert.deepEqual(
    tagCandidates('Firebase', '10.28.0', 'CocoaPods-10.28.0').slice(0, 3),
    ['CocoaPods-10.28.0', '10.28.0', 'v10.28.0'],
  );
  assert.deepEqual(tagCandidates('Alamofire', '5.6.4', '5.6.4'), [
    '5.6.4', 'v5.6.4', 'Alamofire-5.6.4', 'Alamofire-v5.6.4', 'vAlamofire-5.6.4', 'Alamofire/5.6.4',
  ]);
});

test('parses PODS and DEPENDENCIES', () => {
  const lock = `PODS:
  - Alamofire (5.6.4)
  - Firebase/CoreOnly (10.28.0):
    - FirebaseCore (= 10.28.0)
  - Firebase/Crashlytics (10.28.0):
    - Firebase/CoreOnly
  - LocalPod (from \`../LocalPod\`)

DEPENDENCIES:
  - Alamofire (~> 5.6)
  - Firebase/CoreOnly
  - SnapKit

SPEC CHECKSUMS:
  Alamofire: abc
`;
  const { pods, directRoots } = parsePodfileLock(lock);
  assert.deepEqual(directRoots, ['Alamofire', 'Firebase', 'SnapKit']);
  assert.deepEqual(pods.map((p) => p.root), ['Alamofire', 'Firebase', 'LocalPod']);
  assert.deepEqual(pods[1].subspecs, ['CoreOnly', 'Crashlytics']);
  assert.equal(pods[1].version, '10.28.0');
  assert.equal(pods[1].direct, true);
  assert.equal(pods[1].hasRootEntry, false);
  assert.equal(pods[2].version, null, 'non-semver version rejected');
  assert.equal(pods[2].direct, false);
});

test('scanPod: ready when Package.swift exists at tag', async () => {
  const seen = [];
  const fetchMock = async (url) => {
    seen.push(url);
    if (url.includes('.podspec.json')) return ok(specBody({ git: 'https://github.com/a/Pod.git', tag: '1.2.3' }));
    if (url.endsWith('/1.2.3/Package.swift')) return ok('// swift-tools-version: 5.7\n');
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.2.3', subspecs: [], direct: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.tag, '1.2.3');
  assert.equal(result.toolsVersion, '5.7');
  assert.equal(result.sourceUrl, 'https://github.com/a/Pod');
  assert.equal(seen.length, 2);
});

test('scanPod: added-later when only the default branch has Package.swift', async () => {
  const fetchMock = async (url) => {
    if (url.includes('.podspec.json')) return ok(specBody({ git: 'https://github.com/a/Pod.git' }));
    if (url.endsWith('/main/Package.swift')) return ok('// swift-tools-version: 5.9');
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'added-later');
  assert.equal(result.tag, 'main');
});

test('scanPod: no-spm when nothing found', async () => {
  const fetchMock = async (url) =>
    url.includes('.podspec.json') ? ok(specBody({ git: 'https://github.com/a/Pod.git' })) : notFound();
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'no-spm');
});

test('scanPod: podspec missing', async () => {
  const result = await scanPod(notFound, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'no-podspec');
});

test('scanPod: non-GitHub source is reported, not probed', async () => {
  let calls = 0;
  const fetchMock = async (url) => {
    calls++;
    return url.includes('.podspec.json')
      ? ok(specBody({ git: 'https://gitlab.com/a/Pod.git' }))
      : notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'non-github');
  assert.equal(result.sourceUrl, 'https://gitlab.com/a/Pod');
  assert.equal(calls, 1);
});

test('scanPod: no-version skips the network', async () => {
  let calls = 0;
  const result = await scanPod(async () => { calls++; return notFound(); }, { root: 'Pod', version: null, subspecs: [] });
  assert.equal(result.status, 'no-version');
  assert.equal(calls, 0);
});

test('scanPod: retries a transient network failure', async () => {
  let calls = 0;
  const fetchMock = async (url) => {
    calls++;
    if (url.includes('.podspec.json')) {
      if (calls === 1) throw new Error('fetch failed');
      return ok(specBody({ git: 'https://github.com/a/Pod.git', tag: '1.0.0' }));
    }
    return url.endsWith('/1.0.0/Package.swift') ? ok('') : notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'ready');
  assert.equal(calls, 3);
});

test('scanPods preserves order and reports progress', async () => {
  const fetchMock = async (url) => {
    if (url.includes('.podspec.json')) return ok(specBody({ git: 'https://gitlab.com/a/Pod.git' }));
    return notFound();
  };
  const pods = [{ root: 'A', version: '1.0.0' }, { root: 'B', version: '2.0.0' }, { root: 'C', version: '3.0.0' }];
  const seen = [];
  const results = await scanPods(fetchMock, pods, { concurrency: 2, onResult: (r) => seen.push(r.name) });
  assert.deepEqual(results.map((r) => r.name), ['A', 'B', 'C']);
  assert.deepEqual(seen.sort(), ['A', 'B', 'C']);
});
