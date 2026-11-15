// The API contract. `npm run contract` writes openapi.json from the routes in the code; tests/contract.spec.ts fails
// when the committed file and the code disagree — so a change to the API is always a visible change to openapi.json.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SERVICE, VERSION, createApp } from './app.js'
import { loadConfig } from './config.js'
import { connect } from './db/index.js'
import { openApiDocument, stringifyOpenApi } from './kit/api/app.js'

export const CONTRACT_FILE = fileURLToPath(new URL('../openapi.json', import.meta.url))

/** The OpenAPI document of the app as it is right now. Building it never touches a database. */
export function buildContract(): string {
  const config = loadConfig({ PORT: '1', DATABASE_URL: 'sqlite::memory:', LOG_LEVEL: 'error' })
  const app = createApp(config, { database: connect(config) })
  return stringifyOpenApi(openApiDocument(app, { name: SERVICE, version: VERSION }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(CONTRACT_FILE, buildContract())
  console.log(`wrote ${CONTRACT_FILE}`)
}
