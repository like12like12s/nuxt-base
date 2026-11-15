// pm2 processes of {{kit.name}}. Single source of truth for names, ports and env — start through the Pilot API.
// After editing: Pilot action delete -> start (a plain restart keeps the old env), then `pm2 describe`.
// Secrets stay in api/.env (loaded by node --env-file-if-exists), never in this file.
const path = require('node:path')

module.exports = {
  apps: [
    {
      name: '{{kit.name}}-api',
      cwd: path.join(__dirname, 'api'),
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=.env',
      time: true,
      env: { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: {{kit.apiPort}} },
    },
    {
      name: '{{kit.name}}-ui',
      cwd: path.join(__dirname, 'ui'),
      script: '.output/server/index.mjs',
      time: true,
      env: { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: {{kit.uiPort}}, API_URL: 'http://127.0.0.1:{{kit.apiPort}}' },
    },
  ],
}
