// kit/UPGRADING.md -> the notes `scaffold update` prints: what a project owner changes BY HAND in app-owned files
// (update only re-copies locked files and bumps the layer tag — it never rewrites a file the app owns).
//
// Format: one `## <from> -> <to>` section per step, newest first; <from> is a released version, <to> the next released
// version or `next` while that release has not happened. Every top-level `- ` bullet of a section is one note
// (continuation lines are joined). A section applies to a project at version P updated by kit K when the project is
// at or before <from> and the kit is past it: K > from, or K == from with unreleased changes on top.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HEADING = /^##\s+v?(\d+\.\d+\.\d+)\s*->\s*(v?\d+\.\d+\.\d+|next)\s*$/
const parts = (version) => (/^\d+\.\d+\.\d+$/.test(version ?? '') ? version.split('.').map(Number) : [0, 0, 0])
export const compareVersions = (a, b) => {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

export function parseUpgrading(text) {
  const sections = []
  let current = null
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading) {
      current = { from: heading[1], to: heading[2].replace(/^v/, ''), items: [] }
      sections.push(current)
    } else if (/^#{1,2}\s/.test(line)) current = null
    else if (!current) continue
    else if (line.startsWith('- ')) current.items.push(line.slice(2).trim())
    else if (/^\s+\S/.test(line) && current.items.length) current.items[current.items.length - 1] += ` ${line.trim()}`
  }
  return sections.filter((section) => section.items.length)
}

/** The sections a project at `projectVersion` crosses when the kit `kitVersion` (with or without unreleased work) updates it. */
export function upgradeNotes(kit, projectVersion, unreleased) {
  const file = join(kit.root, 'UPGRADING.md')
  if (!existsSync(file)) return []
  return parseUpgrading(readFileSync(file, 'utf8'))
    .filter((section) => compareVersions(projectVersion, section.from) <= 0 && (compareVersions(kit.version, section.from) > 0 || (compareVersions(kit.version, section.from) === 0 && unreleased)))
    .sort((a, b) => compareVersions(a.from, b.from))
}
