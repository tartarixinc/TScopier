process.env.LOAD_USERS = '500'
process.env.LOAD_MIN_SIGNALS = '4'
process.env.LOAD_MAX_SIGNALS = '10'
process.env.LOAD_CONCURRENCY = '16'
process.env.LOAD_PROFILE = 'mixed'
process.env.LOAD_WS_ACCOUNTS = '200'
process.env.LOAD_WS_DURATION_MS = '8000'
process.env.LOAD_WS_HEARTBEAT_MS = '2000'

require('./run-heavy-load.cjs')
