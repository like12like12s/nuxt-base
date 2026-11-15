// @vitest-environment node
// Conditional blocks in templates: one app-owned file serves every module combination.
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM, no types
import { applyConditions, render } from '../lib/render.mjs'

const flags = (...names: string[]) => new Set(names)

describe('@kit:if blocks', () => {
  const text = ['a', '// @kit:if auth', 'with auth', '// @kit:else', 'without auth', '// @kit:end', 'z'].join('\n')

  it('keeps the branch that holds and drops the directive lines', () => {
    expect(applyConditions(text, flags('auth'))).toBe('a\nwith auth\nz')
    expect(applyConditions(text, flags())).toBe('a\nwithout auth\nz')
  })

  it('terms: all must hold; ! negates; kind: / db: / deploy: ask about the selection', () => {
    const t = (expr: string, ...on: string[]) => applyConditions(`// @kit:if ${expr}\nx\n// @kit:end`, flags(...on))
    expect(t('auth trace', 'auth', 'trace')).toBe('x')
    expect(t('auth trace', 'auth')).toBe('')
    expect(t('!auth')).toBe('x')
    expect(t('!auth', 'auth')).toBe('')
    expect(t('kind:fullstack db:mysql', 'kind:fullstack', 'db:mysql')).toBe('x')
    expect(t('auth !kind:api', 'auth', 'kind:api')).toBe('')
  })

  it('nests, and understands the comment style of yaml / env and html / vue files', () => {
    const nested = ['# @kit:if auth', 'A', '  # @kit:if trace', '  AT', '  # @kit:end', '<!-- @kit:else -->', 'none', '<!-- @kit:end -->'].join('\n')
    expect(applyConditions(nested, flags('auth', 'trace'))).toBe('A\n  AT')
    expect(applyConditions(nested, flags('auth'))).toBe('A')
    expect(applyConditions(nested, flags('trace'))).toBe('none')
  })

  it('a directive is a whole line: text that merely mentions @kit:if is left alone', () => {
    const prose = 'const x = 1 // @kit:if auth\nsee `// @kit:end` in the docs'
    expect(applyConditions(prose, flags())).toBe(prose)
  })

  it('unbalanced or malformed blocks are an error that names the file', () => {
    expect(() => applyConditions('// @kit:if auth\nx', flags(), 'app.ts')).toThrow(/without @kit:end in app\.ts/)
    expect(() => applyConditions('// @kit:end', flags(), 'app.ts')).toThrow(/@kit:end without @kit:if in app\.ts/)
    expect(() => applyConditions('// @kit:if\nx\n// @kit:end', flags(), 'app.ts')).toThrow(/without a condition/)
    expect(() => applyConditions('// @kit:if Auth?\nx\n// @kit:end', flags(), 'app.ts')).toThrow(/bad @kit:if term/)
    expect(() => applyConditions('// @kit:if a\n// @kit:else\n// @kit:else\n// @kit:end', flags(), 'app.ts')).toThrow(/second @kit:else/)
  })

  it('render() applies conditions before variables, and only when flags are given', () => {
    expect(render('// @kit:if auth\n{{kit.name}}\n// @kit:end', { name: 'demo' }, 't', flags('auth'))).toBe('demo')
    expect(render('// @kit:if auth\n{{kit.missing}}\n// @kit:end', {}, 't', flags())).toBe('')
    expect(render('// @kit:if auth\nx', {}, 't')).toBe('// @kit:if auth\nx')
  })
})
