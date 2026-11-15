# {{kit.title}}

{{kit.description}}

Scaffolded with the nuxt-base kit {{kit.kitVersion}} — kind `{{kit.kind}}`, modules: {{kit.modules}}, deploy: {{kit.deploy}}.

```bash
npm install
npm run gate        # typecheck + lint + unit tests — must pass before every push and deploy
npm run gate:ci     # gate + gitleaks + npm audit --audit-level=high
```

{{kit.services}}

- How to run, test and deploy: [.memory/docs/guides/usage.md](.memory/docs/guides/usage.md)
- Why this project exists: [.memory/docs/brief/brief.md](.memory/docs/brief/brief.md) · current state: [.memory/docs/context/context.md](.memory/docs/context/context.md)
- Kit-owned files are listed in `.scaffold.json` (`locked`) — do not edit them; `scaffold check` reports drift and
  `scaffold update` re-copies them and bumps the layer tag.

## Keep this repository private

It records how the app is deployed: `.scaffold.json` (`answers`), `docker/`, the env examples and the docs name
hosts, a registry, a domain and internal URLs. There are no credentials in it, but it describes the network — do not
make the repository public or copy those files into a public one without replacing the values.
