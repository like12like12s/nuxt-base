import { toJson } from './fsutil.mjs'

const ORDER = ['name', 'version', 'private', 'description', 'type', 'engines', 'scripts', 'dependencies', 'devDependencies']
const SORTED = new Set(['dependencies', 'devDependencies', 'engines'])

// Merge package.json fragments in unit order: objects merge key by key (later unit wins), scalars are replaced.
export function mergePackage(target, fragment) {
  for (const [key, value] of Object.entries(fragment ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) target[key] = { ...(target[key] ?? {}), ...value }
    else target[key] = value
  }
  return target
}

// Fixed top-level key order, dependency maps sorted (what npm itself writes); scripts keep composition order.
export function stringifyPackage(pkg) {
  const out = {}
  const keys = [...ORDER.filter((k) => k in pkg), ...Object.keys(pkg).filter((k) => !ORDER.includes(k)).sort()]
  for (const key of keys) {
    const value = pkg[key]
    out[key] = SORTED.has(key) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value
  }
  return toJson(out)
}
