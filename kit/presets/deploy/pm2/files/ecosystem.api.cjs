// pm2 processes of {{kit.name}}. Single source of truth for names, ports and env — start through the Pilot API.
// After editing: Pilot action delete -> start (a plain restart keeps the old env), then `pm2 describe`.
// Secrets stay in .env (loaded by node --env-file-if-exists), never in this file.
module.exports = {
  apps: [
    {
      name: '{{kit.name}}',
      cwd: __dirname,
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=.env',
      time: true,
      env: { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: {{kit.apiPort}} },
    },
  ],
}
