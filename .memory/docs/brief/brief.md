---
name: nuxt-base-brief
description: Why nuxt-base exists and what it must / must not do
---

# nuxt-base — Brief

**Problem** (t1085 audit): UI components were copied into 17 projects and drifted in 16; scaffold skills were read ~0–10× in 2,000 sessions; 23 Nuxt versions across projects. What did not drift: a single file copied whole + a cmp check (deploy-docker.sh 9/9).

**Goal**: one Nuxt 4 layer, git-extended with a version tag, so new apps start with tokens, components, async/empty/error patterns, head/OG defaults and an auth hook — and updates propagate by bumping a tag.

**Scope**: Tailwind preset + tokens · core components (single source; ui-kit registry + templates dir read from here) · patterns · head defaults · auth hook point (Authentik) · fixture app + tests.

**Out of scope**: app shells/layouts, business components, `ai scaffold` (next step), drift job across apps (next step), npm publishing (git tag is enough for now).

**Constraints**: zinc dark default for internal tools; external sites override tokens, never fork components · changes happen in the layer, never in an app copy · `npm run gate` green before every tag.
