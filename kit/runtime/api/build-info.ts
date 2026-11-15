// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/build-info.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// What build is running — the `commit` and `builtAt` of GET /version. A deployed image must not answer "unknown":
//   commit    APP_COMMIT (image build arg), else the commit at the end of the image tag the container was started
//             with (APP_IMAGE_TAG — the compose file passes the deployed tag: `20260131-235959-abc1234[-dirty]`)
//   builtAt   APP_BUILT_AT (image build arg), else the time the image build stamped next to the compiled code
//             (dist/build-time.txt, written by the Dockerfile)
// So it works with a deploy script that passes nothing at all, and is exact when the script passes
//   --build-arg APP_COMMIT=$(git rev-parse HEAD) --build-arg APP_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
import { readFileSync } from 'node:fs'

export interface BuildInput {
  /** APP_COMMIT */
  commit?: string
  /** APP_BUILT_AT (ISO-8601) */
  builtAt?: string
  /** APP_IMAGE_TAG — the tag of the running image */
  imageTag?: string
  /** Where the image build wrote its time. Default: build-time.txt next to the compiled code (dist/). */
  stampFile?: string | URL
}

export interface BuildInfo {
  commit?: string
  builtAt?: string
}

const text = (value: string | undefined): string | undefined => value?.trim() || undefined

/** `20260131-235959-abc1234` -> `abc1234` · `…-abc1234-dirty` -> `abc1234-dirty` · a tag without a commit -> undefined. */
export function commitFromTag(tag: string | undefined): string | undefined {
  const value = text(tag)
  if (!value) return undefined
  const stamped = /^\d{8}-\d{6}-([0-9a-f]{7,40})(-dirty)?$/.exec(value)
  if (stamped) return stamped[1]! + (stamped[2] ?? '')
  // Any other scheme: a trailing hex segment counts only when it has a letter (a date like 20260131 is not a commit).
  const tail = /(?:^|[-_.])([0-9a-f]{7,40})(-dirty)?$/.exec(value)
  return tail && /[a-f]/.test(tail[1]!) ? tail[1]! + (tail[2] ?? '') : undefined
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function stamp(file: string | URL): string | undefined {
  try {
    const value = readFileSync(file, 'utf8').trim()
    return ISO.test(value) ? value : undefined
  } catch {
    return undefined // not an image build (tsx, tests, a plain `npm run build`)
  }
}

/** Pass the result as `build` to createApi(). A value that is not known stays undefined (/version says "unknown"). */
export function buildInfo(input: BuildInput = {}): BuildInfo {
  const commit = text(input.commit) ?? commitFromTag(input.imageTag)
  const builtAt = text(input.builtAt) ?? stamp(input.stampFile ?? new URL('../../build-time.txt', import.meta.url))
  return { ...(commit ? { commit } : {}), ...(builtAt ? { builtAt } : {}) }
}
