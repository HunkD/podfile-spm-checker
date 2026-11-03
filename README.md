# Podfile → SPM Checker

A static, client-side web app that answers one question: **does every pod in my
`Podfile.lock` ship a Swift Package Manager package at the same version?**

Drop a `Podfile.lock` and the app resolves each pod's git repository and
checks whether `Package.swift` exists at the matching tag.

Live site: <https://hunkd.github.io/podfile-spm-checker/>

- No backend, no build step, no analytics.
- The lockfile never leaves the browser. Only pod names, versions, and repo
  paths are sent to the CocoaPods CDN and the git host APIs used for the check
  (GitHub, GitLab, Bitbucket, Gitee, Codeberg/Gitea).
- Results are cached in `localStorage` for 7 days (clear with the footer link).

## What it checks

For every root pod in the `PODS` section:

1. Fetch the published podspec from the CocoaPods CDN
   (`cdn.jsdelivr.net/cocoa/Specs/...`, sharded by the MD5 of the pod name).
2. Take `source.git` from the podspec and normalize the repo path. GitHub,
   GitLab (including subgroups), Bitbucket, Gitee, and Codeberg/Gitea are read
   through CORS-enabled raw-file endpoints or APIs. If the podspec has no
   `source.git` but its `source.http` points at a GitHub release asset or
   archive, infer the owner/repo from that URL and probe it. This catches
   binary pods that still ship SPM from their source repository (for example,
   `BrazeKit`).
3. Probe `Package.swift` for:
   - the tag pinned in the podspec,
   - the lockfile version,
   - common spellings (`v1.2.3`, `Pod-1.2.3`, `vPod-1.2.3`, …).
4. If no tag matches, check the `main` and `master` branches to detect SPM
   support that was added after the release.
5. If the CocoaPods repo has no manifest, probe common separate-repo names
   (`<repo>-spm`, `<repo>-swiftpm`, `<repo>-swift-package`,
   `swift-package-manager-<repo>`) on `main`/`master`.
6. User-supplied overrides (`PodName = repository URL`) are probed instead of
   the podspec repo. Overrides are the reliable escape hatch for arbitrary
   separate repos or public mirrors. Self-hosted instances can be forced with a
   prefix: `PodName = gitlab+https://git.example.com/group/Pod` (also `gitea+`,
   `bitbucket+`, `gitee+`, `github+`).

### Statuses

| Status | Meaning |
| --- | --- |
| **SPM ready** | `Package.swift` exists at the matching tag. |
| **SPM added later** | No `Package.swift` at this version, but `main`/`master` has one — upgrading would unlock SPM. |
| **SPM in other repo** | `Package.swift` found in a commonly named separate repo. Confirm the two release lines match, or set an override. |
| **No Package.swift** | Repository resolved, but no `Package.swift` at any probed tag, default branch, or separate-repo candidate. |
| **No git repo** | Podspec has no `source.git`, and its `source.http` is not a GitHub release/archive URL to infer a repository from (binary SDK, zip/tarball, or other non-git distribution). Check the vendor's SPM docs. |
| **Host not checked** | Repo is on a host without a CORS-enabled file API (self-hosted GitLab/Gitea, other hosts), or the URL is unrecognized. Add an override to check it. |
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
- **Self-hosted hosts.** Self-hosted GitLab/Gitea and other git servers are
  reported as "Host not checked". If the instance exposes CORS-enabled API
  access, force the adapter with a `gitlab+`/`gitea+` override.
- **Separate-repo detection is a heuristic.** Only common names are tried; the
  version match is not verified across repositories. Use overrides to be
  certain.
- **Exact versions.** The version from `Podfile.lock` is used as-is; no
  nearest-version matching.
- **Politeness and rate limits.** Each pod costs a few HTTP requests; the
  separate-repo heuristic adds more for repos without a manifest. Bitbucket and
  Gitee APIs have anonymous rate limits, so a very large lockfile can produce
  "Check failed" rows. Results are cached for 7 days afterwards.

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
