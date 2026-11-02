# Podfile → SPM Checker

A static, client-side web app that answers one question: **does every pod in my
`Podfile.lock` ship a Swift Package Manager package at the same version?**

Drop a `Podfile.lock` and the app resolves each pod's GitHub repository and
checks whether `Package.swift` exists at the matching tag.

Live site: <https://hunkd.github.io/podfile-spm-checker/>

- No backend, no build step, no analytics.
- The lockfile never leaves the browser. Only pod names and versions are sent
  to the CocoaPods CDN and `raw.githubusercontent.com`.
- Results are cached in `localStorage` for 7 days (clear with the footer link).

## What it checks

For every root pod in the `PODS` section:

1. Fetch the published podspec from the CocoaPods CDN
   (`cdn.jsdelivr.net/cocoa/Specs/...`, sharded by the MD5 of the pod name).
2. Take `source.git` from the podspec and normalize the GitHub `owner/repo`.
3. Probe `raw.githubusercontent.com/<owner>/<repo>/<tag>/Package.swift` for:
   - the tag pinned in the podspec,
   - the lockfile version,
   - common spellings (`v1.2.3`, `Pod-1.2.3`, `vPod-1.2.3`, …).
4. If no tag matches, check the `main` and `master` branches to detect SPM
   support that was added after the release.

### Statuses

| Status | Meaning |
| --- | --- |
| **SPM ready** | `Package.swift` exists at the matching tag. |
| **SPM added later** | No `Package.swift` at this version, but `main`/`master` has one — upgrading would unlock SPM. |
| **No Package.swift** | Repository resolved, but no `Package.swift` at any probed tag or default branch. |
| **Not GitHub** | Podspec uses a non-GitHub git host (GitLab, Bitbucket, self-hosted). |
| **Podspec not found** | Version is not on the main CocoaPods trunk (private pod, custom spec repo, or local path). |
| **No version** | Local/external pod without a semver version in the lockfile. |
| **Check failed** | Network or parse error; retry or inspect the repository manually. |

## Running locally

The app is plain HTML/CSS/ES modules, so any static server works:

```sh
npm run serve          # python3 -m http.server 8080
# open http://localhost:8080
```

ES modules do not load over `file://`; use a server.

## Tests

Pure logic in [`lib.js`](lib.js) is tested with Node's built-in test runner
(Node 18+):

```sh
npm test               # node --test test/lib.test.mjs
```

No dependencies are installed.

## Deployment

The included workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
deploys the repository root to GitHub Pages on every push to `main`.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub
Actions**, then push to `main`.

## Limitations

- **Root pods only.** Subspecs (`Firebase/CoreOnly`) are reported with the root
  pod, because SPM packages are per repository, not per subspec.
- **Tag heuristics.** Repositories with unusual tag formats can produce a false
  "No Package.swift". Every row links its repository for a manual check.
- **Trunk only.** Pods from private or custom spec repos cannot be resolved.
- **GitHub only.** SPM support in GitLab/Bitbucket repos is not checked.
- **Exact versions.** The version from `Podfile.lock` is used as-is; no
  nearest-version matching.
- **Politeness.** Each pod costs a few HTTP requests. Very large lockfiles take
  proportionally longer; results are cached afterwards.

Not affiliated with Apple, CocoaPods, or GitHub.

## Project layout

```
index.html            UI
app.js                DOM wiring, rendering, exports
lib.js                pure logic: parser, MD5, CDN URLs, scan pipeline
styles.css            light/dark theme
test/lib.test.mjs     unit tests (node:test)
.github/workflows/    GitHub Pages deployment
```
