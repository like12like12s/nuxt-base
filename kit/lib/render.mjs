// Template variables look like {{kit.name}} — the `kit.` prefix keeps them apart from Vue's own {{ }} mustaches.
const VAR = /\{\{kit\.([A-Za-z][A-Za-z0-9]*)\}\}/g

// Conditional blocks: a line that holds nothing but a comment `@kit:if <expr>` / `@kit:else` / `@kit:end`, in the
// comment style of the file (`// @kit:if auth`, `# @kit:if auth`, `<!-- @kit:if auth -->`). The directive lines are
// removed; the lines between them are kept when <expr> holds. <expr> = terms separated by spaces, all must hold:
//   auth        the module is selected            !auth          it is not
//   kind:api    the project's kind is `api`       !kind:api      it is not
//   db:mysql    the --db value is `mysql`         deploy:pm2     the deploy preset is `pm2`
// Blocks nest. That is how one app-owned file (src/app.ts) serves every module combination.
const DIRECTIVE = /^[ \t]*(?:\/\/|#|<!--)[ \t]*@kit:(if|else|end)\b[ \t]*(.*?)[ \t]*(?:-->)?[ \t]*$/

function holds(expr, flags, where) {
  const terms = expr.split(/\s+/).filter(Boolean)
  if (!terms.length) throw new Error(`@kit:if without a condition in ${where}`)
  return terms.every((term) => {
    const negate = term.startsWith('!')
    const name = negate ? term.slice(1) : term
    if (!/^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/.test(name)) throw new Error(`bad @kit:if term "${term}" in ${where}`)
    return flags.has(name) !== negate
  })
}

export function applyConditions(text, flags, where = 'template') {
  if (!text.includes('@kit:')) return text
  const out = []
  const stack = [] // { keep: this branch is active, parent: the enclosing block is active, seenElse }
  const active = () => stack.every((s) => s.keep)
  for (const line of text.split('\n')) {
    const m = DIRECTIVE.exec(line)
    if (!m) {
      if (active()) out.push(line)
      continue
    }
    const [, word, expr] = m
    if (word === 'if') stack.push({ keep: holds(expr, flags, where), seenElse: false })
    else if (!stack.length) throw new Error(`@kit:${word} without @kit:if in ${where}`)
    else if (word === 'else') {
      const top = stack.at(-1)
      if (top.seenElse) throw new Error(`second @kit:else in one block in ${where}`)
      top.seenElse = true
      top.keep = !top.keep
    } else stack.pop()
  }
  if (stack.length) throw new Error(`@kit:if without @kit:end in ${where}`)
  return out.join('\n')
}

/** `flags` (a Set, see applyConditions) is optional: without it the text is only variable-substituted. */
export function render(text, vars, where = 'template', flags = null) {
  const body = flags ? applyConditions(text, flags, where) : text
  return body.replace(VAR, (_, key) => {
    if (!(key in vars)) throw new Error(`unknown template variable {{kit.${key}}} in ${where}`)
    return String(vars[key])
  })
}

// `dot.gitignore` in the kit tree becomes `.gitignore` in the app (a real dotfile in the kit would act on this repo).
export const undot = (path) => path.split('/').map((seg) => (seg.startsWith('dot.') ? seg.slice(3) : seg)).join('/')
