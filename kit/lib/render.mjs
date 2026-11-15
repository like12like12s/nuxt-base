// Template variables look like {{kit.name}} — the `kit.` prefix keeps them apart from Vue's own {{ }} mustaches.
const VAR = /\{\{kit\.([A-Za-z][A-Za-z0-9]*)\}\}/g

export function render(text, vars, where = 'template') {
  return text.replace(VAR, (_, key) => {
    if (!(key in vars)) throw new Error(`unknown template variable {{kit.${key}}} in ${where}`)
    return String(vars[key])
  })
}

// `dot.gitignore` in the kit tree becomes `.gitignore` in the app (a real dotfile in the kit would act on this repo).
export const undot = (path) => path.split('/').map((seg) => (seg.startsWith('dot.') ? seg.slice(3) : seg)).join('/')
