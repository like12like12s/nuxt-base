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
  else if (/s$/.test(last) && !/(ss|us|is)$/.test(last)) one = last.slice(0, -1)
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
