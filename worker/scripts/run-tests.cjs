const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const workerRoot = path.join(__dirname, '..')

function collectTestFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectTestFiles(full, out)
    } else if (ent.name.endsWith('.test.ts') && !ent.name.endsWith('.perf.test.ts')) {
      out.push(full)
    }
  }
  return out
}

const testFiles = collectTestFiles(path.join(workerRoot, 'src')).sort()

if (testFiles.length === 0) {
  console.error('No worker test files found under src/')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--require', 'ts-node/register', '--test', ...testFiles],
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
