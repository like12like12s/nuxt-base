// Loads the kit tree: kinds/<name>/kind.json, modules/<name>/module.json, presets/deploy/<name>/preset.json.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson } from './fsutil.mjs'

export const DEFAULT_KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The layer lives in the same repo as the kit, so one git tag versions both (kit version = layer tag).
export const LAYER_REPO = 'github:like12like12s/nuxt-base'
export const PART_TYPES = ['api', 'ui']
export const GENERATOR_TYPES = ['resource', 'page', 'job']

function loadUnits(dir, file) {
  const units = new Map()
  if (!existsSync(dir)) return units
  for (const name of readdirSync(dir).sort()) {
    const unitDir = join(dir, name)
    const manifest = join(unitDir, file)
    if (!statSync(unitDir).isDirectory() || !existsSync(manifest)) continue
    const unit = readJson(manifest)
    if (unit.name !== name) throw new Error(`${manifest}: "name" must equal the directory name (${name})`)
    units.set(name, { ...unit, dir: unitDir })
  }
  return units
}

export function loadKit(root = DEFAULT_KIT_ROOT) {
  root = resolve(root)
  // Kit version = version of the repo that carries it (nuxt-base/package.json); the lead bumps it with each tag.
  const pkgFile = join(root, '..', 'package.json')
  const version = existsSync(pkgFile) ? readJson(pkgFile).version ?? '0.0.0' : '0.0.0'
  return {
    root,
    version,
    layerRef: `${LAYER_REPO}#v${version}`,
    kinds: loadUnits(join(root, 'kinds'), 'kind.json'),
    modules: loadUnits(join(root, 'modules'), 'module.json'),
    presets: loadUnits(join(root, 'presets', 'deploy'), 'preset.json'),
  }
}

// `github:like12like12s/nuxt-base#v1.2.3` -> [1, 2, 3]; anything else (a local path, a fork) -> null = not comparable.
export function layerVersion(ref) {
  const m = typeof ref === 'string' && ref.startsWith(`${LAYER_REPO}#v`) ? /^(\d+)\.(\d+)\.(\d+)$/.exec(ref.slice(LAYER_REPO.length + 2)) : null
  return m ? m.slice(1).map(Number) : null
}

export function isBehind(ref, latestRef) {
  const a = layerVersion(ref)
  const b = layerVersion(latestRef)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}
