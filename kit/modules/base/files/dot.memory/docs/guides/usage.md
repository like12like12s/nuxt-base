---
name: {{kit.name}}-usage
description: How to run, test and deploy {{kit.name}}
---
# {{kit.title}} — Usage

{{kit.usageSections}}

## Checks

```bash
npm run gate        # typecheck -> unit tests. Runs on every push (pre-push hook) and before every deploy.
npm run gate:ci     # gate + gitleaks (skipped with a notice when the binary is absent) + npm audit --audit-level=high
```

## Kit-owned files

`.scaffold.json` lists the locked files (sha256) and the layer tag this project was generated with.

```bash
scaffold check      # exit 1 when a locked file was edited / is missing / is behind the kit, or the layer tag is behind
scaffold update     # re-copy locked files + bump the layer tag — never touches app-owned files
```
