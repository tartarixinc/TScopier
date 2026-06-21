/** Options passed from dispatch into management execution (live fast path). */
export type MgmtExecOptions = {
  /** Live Telegram mgmt: parallel legs, fast close/modify, reduced straggler rounds. */
  liveMgmtFast?: boolean
}

/** Metrics returned from applyManagement for pipeline logging. */
export type MgmtExecResult = {
  legsTotal: number
  legsParallelism: number
}
