import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  md5, shardPath, podspecUrl, rawFileUrl, packageSwiftUrl,
  parsePodfileLock, normalizeGitUrl, repoFromBinaryUrl, tagCandidates, parseOverrides,
  spmRepoCandidates, swiftPackageIndexUrl, scanPod, scanPods,
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

  const gitlab = normalizeGitUrl('https://gitlab.com/group/sub/Pod.git');
  assert.equal(gitlab.path, 'group/sub/Pod');
  assert.equal(gitlab.name, 'Pod');
  assert.equal(gitlab.kind, 'gitlab');
  assert.equal(normalizeGitUrl('https://codeberg.org/a/Pod').kind, 'gitea');
  assert.equal(normalizeGitUrl('https://gitee.com/a/Pod').kind, 'gitee');
  assert.equal(normalizeGitUrl('https://git.example.com/a/Pod').kind, 'unknown');
});

test('packageSwiftUrl uses a CORS-enabled endpoint per host', () => {
  const pkg = (url, ref = '1.2.3') => packageSwiftUrl(normalizeGitUrl(url), ref);
  assert.equal(
    pkg('https://github.com/a/Pod.git'),
    'https://raw.githubusercontent.com/a/Pod/1.2.3/Package.swift',
  );
  assert.equal(
    pkg('https://gitlab.com/group/sub/Pod.git'),
    'https://gitlab.com/api/v4/projects/group%2Fsub%2FPod/repository/files/Package.swift/raw?ref=1.2.3',
  );
  assert.equal(
    pkg('https://bitbucket.org/team/Pod.git'),
    'https://api.bitbucket.org/2.0/repositories/team/Pod/src/1.2.3/Package.swift',
  );
  assert.equal(
    pkg('https://codeberg.org/a/Pod.git', 'main'),
    'https://codeberg.org/api/v1/repos/a/Pod/raw/Package.swift?ref=main',
  );
  assert.equal(
    pkg('https://gitee.com/a/Pod.git'),
    'https://gitee.com/api/v5/repos/a/Pod/contents/Package.swift?ref=1.2.3',
  );
});

test('spmRepoCandidates keeps the owner and GitLab subgroups', () => {
  const repo = normalizeGitUrl('https://gitlab.com/group/sub/Pod.git');
  const names = spmRepoCandidates(repo).map((c) => c.name);
  assert.deepEqual(names, ['Pod-spm', 'Pod-swiftpm', 'Pod-swift-package', 'swift-package-manager-Pod']);
  assert.equal(spmRepoCandidates(repo)[0].path, 'group/sub/Pod-spm');
  assert.equal(spmRepoCandidates(repo)[0].url, 'https://gitlab.com/group/sub/Pod-spm');
});

test('parseOverrides reads name=repo lines', () => {
  const map = parseOverrides(`
# comment
AWSCore = https://github.com/aws-amplify/aws-sdk-ios-spm
Google-Mobile-Ads-SDK = googleads/swift-package-manager-google-mobile-ads
ScpPod = git@github.com:a/Pod.git
  `);
  assert.equal(map.get('AWSCore'), 'https://github.com/aws-amplify/aws-sdk-ios-spm');
  assert.equal(
    map.get('Google-Mobile-Ads-SDK'),
    'https://github.com/googleads/swift-package-manager-google-mobile-ads',
  );
  assert.equal(map.get('ScpPod'), 'git@github.com:a/Pod.git');
  assert.throws(() => parseOverrides('NoEqualsSign'), /expected/i);
  assert.throws(() => parseOverrides('= https://github.com/a/b'), /expected/i);
  assert.equal(parseOverrides('').size, 0);
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

test('scanPod: unrecognized host is reported without probing it', async () => {
  let calls = 0;
  const fetchMock = async (url) => {
    calls++;
    return url.includes('.podspec.json')
      ? ok(specBody({ git: 'https://git.example.com/a/Pod.git' }))
      : notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'unverified');
  assert.equal(result.sourceUrl, undefined);
  assert.equal(result.podRepoUrl, 'https://git.example.com/a/Pod');
  assert.equal(calls, 1);
});

test('scanPod: non-git podspec is reported', async () => {
  let calls = 0;
  const fetchMock = async (url) => {
    calls++;
    return url.includes('.podspec.json')
      ? ok(specBody({ http: 'https://example.com/Pod.zip' }))
      : notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'non-git');
  assert.equal(calls, 1);
});

test('repoFromBinaryUrl infers GitHub release and archive repositories', () => {
  assert.equal(
    repoFromBinaryUrl('https://github.com/braze-inc/braze-swift-sdk/releases/download/14.0.2/BrazeKit.zip').url,
    'https://github.com/braze-inc/braze-swift-sdk',
  );
  assert.equal(
    repoFromBinaryUrl('https://github.com/a/Pod/archive/refs/tags/1.0.0.tar.gz').url,
    'https://github.com/a/Pod',
  );
  assert.equal(repoFromBinaryUrl('https://example.com/Pod.zip'), null);
  assert.equal(repoFromBinaryUrl('https://github.com/a/Pod'), null);
  assert.equal(repoFromBinaryUrl(null), null);
});

test('swiftPackageIndexUrl searches for the pod name', () => {
  assert.equal(
    swiftPackageIndexUrl('FullStory'),
    'https://swiftpackageindex.com/search?query=FullStory',
  );
  assert.equal(
    swiftPackageIndexUrl('Google-Mobile-Ads-SDK'),
    'https://swiftpackageindex.com/search?query=Google-Mobile-Ads-SDK',
  );
});

test('scanPod: binary pod infers its GitHub repository', async () => {
  const releaseUrl = 'https://github.com/braze-inc/braze-swift-sdk/releases/download/14.0.2/BrazeKit.zip';
  const seen = [];
  const fetchMock = async (url) => {
    seen.push(url);
    if (url.includes('.podspec.json')) return ok(specBody({ http: releaseUrl }));
    if (url.endsWith('/14.0.2/Package.swift')) return ok('// swift-tools-version: 5.7\n');
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'BrazeKit', version: '14.0.2', subspecs: [] });
  assert.equal(result.status, 'ready');
  assert.equal(result.podRepoUrl, 'https://github.com/braze-inc/braze-swift-sdk');
  assert.equal(result.sourceUrl, 'https://github.com/braze-inc/braze-swift-sdk');
  assert.equal(result.inferredFrom, releaseUrl);
  assert.ok(seen.some((url) => url.endsWith('/14.0.2/Package.swift')));
});

test('scanPod: inferred GitHub repository without Package.swift is no-spm', async () => {
  const fetchMock = async (url) =>
    url.includes('.podspec.json')
      ? ok(specBody({ http: 'https://github.com/a/Pod/releases/download/1.0.0/Pod.zip' }))
      : notFound();
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'no-spm');
  assert.equal(result.podRepoUrl, 'https://github.com/a/Pod');
});

test('scanPod: GitLab uses the API and finds Package.swift', async () => {
  const seen = [];
  const fetchMock = async (url) => {
    seen.push(url);
    if (url.includes('.podspec.json')) {
      return ok(specBody({ git: 'https://gitlab.com/group/sub/Pod.git', tag: '1.2.3' }));
    }
    if (url.includes('/api/v4/projects/group%2Fsub%2FPod/repository/files/Package.swift/raw?ref=1.2.3')) {
      return ok('// swift-tools-version: 5.7\n');
    }
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.2.3', subspecs: [] });
  assert.equal(result.status, 'ready');
  assert.equal(result.sourceUrl, 'https://gitlab.com/group/sub/Pod');
  assert.equal(result.toolsVersion, '5.7');
  assert.ok(seen.some((u) => u.includes('/api/v4/projects/')));
});

test('scanPod: Gitee decodes the contents API', async () => {
  const packageSwift = '// swift-tools-version: 5.9\n';
  const content = Buffer.from(packageSwift).toString('base64');
  const fetchMock = async (url) => {
    if (url.includes('.podspec.json')) return ok(specBody({ git: 'https://gitee.com/a/Pod.git' }));
    if (url.includes('/contents/Package.swift') && url.endsWith('ref=1.0.0')) {
      return ok(JSON.stringify({ type: 'file', encoding: 'base64', content }));
    }
    if (url.includes('gitee.com/api/v5')) return ok('[]');
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'ready');
  assert.equal(result.tag, '1.0.0');
  assert.equal(result.toolsVersion, '5.9');
});

test('scanPod: Gitee 200 + [] is not a Package.swift', async () => {
  const fetchMock = async (url) => {
    if (url.includes('.podspec.json')) return ok(specBody({ git: 'https://gitee.com/a/Pod.git' }));
    if (url.includes('gitee.com/api/v5')) return ok('[]');
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'no-spm');
});

test('scanPod: finds Package.swift in a separate -spm repository', async () => {
  const fetchMock = async (url) => {
    if (url.includes('.podspec.json')) return ok(specBody({ git: 'https://github.com/a/Pod.git' }));
    if (url === 'https://raw.githubusercontent.com/a/Pod-spm/main/Package.swift') {
      return ok('// swift-tools-version: 5.8\n');
    }
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] });
  assert.equal(result.status, 'spm-repo');
  assert.equal(result.sourceUrl, 'https://github.com/a/Pod-spm');
  assert.equal(result.podRepoUrl, 'https://github.com/a/Pod');
  assert.equal(result.tag, 'main');
  assert.match(result.detail, /separate repository/);
});

test('scanPod: an override probes the supplied repository', async () => {
  const fetchMock = async (url) => {
    if (url.includes('.podspec.json')) return ok(specBody({ git: 'https://github.com/a/Pod.git' }));
    if (url === 'https://raw.githubusercontent.com/b/Other/2.0.0/Package.swift') {
      return ok('// swift-tools-version: 6.0\n');
    }
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '2.0.0', subspecs: [] }, {
    override: 'https://github.com/b/Other',
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.sourceUrl, 'https://github.com/b/Other');
  assert.equal(result.podRepoUrl, 'https://github.com/a/Pod');
  assert.equal(result.overridden, true);
  assert.equal(result.toolsVersion, '6.0');
});

test('scanPod: override prefix forces an adapter for self-hosted hosts', async () => {
  const fetchMock = async (url) => {
    if (url.includes('.podspec.json')) return ok(specBody({}));
    if (url === 'https://git.example.com/api/v4/projects/group%2FPod/repository/files/Package.swift/raw?ref=1.0.0') {
      return ok('// swift-tools-version: 5.5\n');
    }
    return notFound();
  };
  const result = await scanPod(fetchMock, { root: 'Pod', version: '1.0.0', subspecs: [] }, {
    override: 'gitlab+https://git.example.com/group/Pod',
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.sourceUrl, 'https://git.example.com/group/Pod');
  assert.equal(result.toolsVersion, '5.5');
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
