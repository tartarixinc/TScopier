require('./loadEnv.cjs')

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const workerRoot = path.join(__dirname, '..')

const result = spawnSync(
  process.execPath,
  ['--require', 'ts-node/register', path.join(workerRoot, 'src/diagnostics/liveFxsocketWsHeartbeat.ts')],
  {
    cwd: workerRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      LOAD_WS_LIVE: '1',
      TS_NODE_PROJECT: path.join(workerRoot, 'tsconfig.test.json'),
    },
  },
)

process.exit(result.status ?? 1)
