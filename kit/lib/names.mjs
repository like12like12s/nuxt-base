// Names a generator derives from the one kebab-case name it is given (`order-lines`).
const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1)

/** `order-lines` -> `order-line` · `categories` -> `category` · `boxes` -> `box` · `status` stays `status`. */
export function singular(kebab) {
  const parts = kebab.split('-')
  const last = parts.pop()
  let one = last
  if (['news', 'series', 'species'].includes(last)) one = last
  else if (/[^aeiou]ies$/.test(last)) one = last.slice(0, -3) + 'y'
  else if (/(ches|shes|sses|xes|zes|uses)$/.test(last)) one = last.slice(0, -2)
  else if (last.endsWith('s') && !/(ss|us|is)$/.test(last)) one = last.slice(0, -1)
  return [...parts, one].join('-')
}

export function names(kebab) {
  const one = singular(kebab)
  const pascal = (text) => text.split('-').map(cap).join('')
  const camel = (text) => text.split('-').map((word, i) => (i ? cap(word) : word)).join('')
  return {
    kebab, // order-lines        route segment, folder and file names
    snake: kebab.replaceAll('-', '_'), // order_lines        table
    camel: camel(kebab), // orderLines
    pascal: pascal(kebab), // OrderLines
    one, // order-line
    oneSnake: one.replaceAll('-', '_'), // order_line         audit action prefix / target prefix
    oneCamel: camel(one), // orderLine
    onePascal: pascal(one), // OrderLine
    title: kebab.split('-').map(cap).join(' '), // Order Lines
    oneTitle: one.split('-').map(cap).join(' '), // Order Line
    constant: kebab.replaceAll('-', '_').toUpperCase(), // ORDER_LINES
  }
}

// Words a generated identifier must not be: `add job delete` would write `export const delete = …` (a syntax error),
// `add resource errors` would declare `type Error` and shadow the built-in in every file that imports it.
const RESERVED = new Set(
  ('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof ' +
    'new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public ' +
    'await arguments eval undefined nan infinity').split(' '),
)
const GLOBALS = new Set(
  ('Object Array String Number Boolean Symbol BigInt Function Error Date Map Set WeakMap WeakSet Promise Proxy Reflect JSON Math RegExp Intl URL Request Response ' +
    'Headers Blob File Event Record Partial Required Pick Omit Readonly Buffer Schema Kysely').split(' '),
)

/** Why `kebab` cannot name a generated page / resource / job, or null when it can. */
export function reservedName(kebab) {
  const n = names(kebab)
  for (const word of [n.camel, n.oneCamel]) if (RESERVED.has(word.toLowerCase())) return `"${word}" is a reserved word in JavaScript / TypeScript`
  for (const word of [n.pascal, n.onePascal]) if (GLOBALS.has(word)) return `"${word}" would shadow a built-in type`
  return null
}
