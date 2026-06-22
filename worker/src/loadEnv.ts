import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const workerRoot = resolve(__dirname, '..')

config({ path: resolve(workerRoot, '.env') })
if (existsSync(resolve(workerRoot, '.env.local'))) {
  config({ path: resolve(workerRoot, '.env.local'), override: true })
}
