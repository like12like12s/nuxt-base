// Where the kit that is running came from: which commit, and whether it is exactly a release.
//
// A project is compared against "the kit" — but a kit directory that is a git checkout may hold work that no release
// has (commits after the tag, or an edited working tree). Locked files then differ from every project although no
// project changed and no version was released; reporting that as project drift sends people to "fix" projects that
// are fine. So `check` / `update` say which kit they compared against (version + commit) and whether that kit has
// unreleased changes. Consumers should read the kit from a release tag; this is what tells them when they do not.
//
// Read-only: a few `git` queries on the kit's own repository. A kit that is not a git checkout (an exported release,
// a tarball) has no commit and counts as released — there is nothing to compare it with.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

const cache = new Map()

/** @returns {{ commit: string | null, tag: string, unreleased: boolean, why: string | null }} */
export function kitSource(kit) {
  if (kit.source) return kit.source // injected (tests)
  if (cache.has(kit.root)) return cache.get(kit.root)
  const repo = join(kit.root, '..')
  const tag = `v${kit.version}`
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  const out = (...args) => {
    const r = git(...args)
    return r.status === 0 ? r.stdout.trim() : null
  }
  let source = { commit: null, tag, unreleased: false, why: null }
  try {
    // Only when the kit's repository IS the checkout (not a kit copied into some other repository).
    const top = out('rev-parse', '--show-toplevel')
    if (top && realpathSync(top) === realpathSync(repo)) {
      const commit = out('rev-parse', 'HEAD')
      const released = out('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`)
      let why = null
      if (!released) why = `this checkout has no tag ${tag}`
      else if (git('diff', '--quiet', `refs/tags/${tag}`, '--', 'kit').status !== 0) why = `kit/ differs from ${tag}`
      else if (out('ls-files', '--others', '--exclude-standard', '--', 'kit')) why = `kit/ has files that are not in ${tag}`
      source = { commit, tag, unreleased: why !== null, why }
    }
  } catch {
    /* no git, or not a repository: an exported kit */
  }
  cache.set(kit.root, source)
  return source
}

export const shortCommit = (commit) => (commit ? commit.slice(0, 7) : null)
