const { config } = require('dotenv')
const { existsSync } = require('fs')
const path = require('path')

const workerRoot = path.join(__dirname, '..')

config({ path: path.join(workerRoot, '.env') })
if (existsSync(path.join(workerRoot, '.env.local'))) {
  config({ path: path.join(workerRoot, '.env.local'), override: true })
}
