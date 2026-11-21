---
name: {{kit.name}}-usage
description: How to run, test and deploy {{kit.name}}
---
# {{kit.title}} — Usage

{{kit.usageSections}}

## Checks

```bash
npm run gate        # typecheck -> lint (oxlint, warnings fail) -> unit tests. Before every push and every deploy.
npm run gate:ci     # gate + gitleaks (skipped with a notice when the binary is absent) + npm audit --audit-level=high
npm run gate:full   # the full tier (gate + build, and all e2e where the project has them) — before a release / nightly
```

Secret scan: `gate:ci` scans the whole git history (`gitleaks detect`) and, on your machine, also what is not
committed yet (`gitleaks protect`). A pre-commit hook (`gitleaks protect --staged`) sees only what is about to be
committed — so a finding in an old commit shows up in `gate:ci` alone, and no later commit removes it. A false
positive: add the `Fingerprint:` line that `gitleaks detect -v` prints to `.gitleaksignore` (one per line; all
modes read it). A real secret: rotate it first, then ignore the fingerprint.

## Kit-owned files

`.scaffold.json` lists the locked files (sha256) and the layer tag this project was generated with.

```bash
scaffold check      # exit 1 when a locked file was edited / is missing / is behind the kit, or the layer tag is behind;
                    # names the kit version + commit it compared against
scaffold update     # re-copy locked files + bump the layer tag — never touches app-owned files; prints what to change
                    # by hand for the version steps crossed (the kit's UPGRADING.md)
scaffold update --show <path>   # print a file as the current kit generates it for this project (writes nothing):
                    # the current form of an app-owned file, to diff against yours
```
