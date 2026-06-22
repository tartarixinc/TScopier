const { spawnSync } = require('node:child_process')
const path = require('node:path')

require('./loadEnv.cjs')

const workerRoot = path.join(__dirname, '..')

const result = spawnSync(
  process.execPath,
  ['--require', 'ts-node/register', path.join(workerRoot, 'src/diagnostics/heavyTelegramLoad.ts')],
  {
    cwd: workerRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      TS_NODE_PROJECT: path.join(workerRoot, 'tsconfig.test.json'),
    },
  },
)

process.exit(result.status ?? 1)
