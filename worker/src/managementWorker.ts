import { SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const EXECUTE_TRADE_URL = process.env.EXECUTE_TRADE_URL ?? (
  SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/execute-trade` : ''
)

const POLL_MS = Math.max(2000, Number(process.env.MANAGEMENT_WORKER_POLL_MS ?? 4000))
const BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.MANAGEMENT_WORKER_BATCH_SIZE ?? 8)))

type MgmtJob = {
  id: string
  user_id: string
  signal_id: string
  action: string
  parsed_data: Record<string, unknown>
  attempts: number
  max_attempts: number
}

export class ManagementWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly workerId: string

  constructor(private readonly supabase: SupabaseClient) {
    this.workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[managementWorker] tick failed:', err))
    }, POLL_MS)
    // fire one immediately
    this.tick().catch(err => console.error('[managementWorker] initial tick failed:', err))
    console.log(`[managementWorker] started poll=${POLL_MS}ms batch=${BATCH_SIZE}`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick() {
    if (this.running) return
    this.running = true
    try {
      if (!EXECUTE_TRADE_URL || !SUPABASE_SERVICE_ROLE_KEY) return

      const nowIso = new Date().toISOString()
      const { data: rows, error } = await this.supabase
        .from('management_jobs')
        .select('id,user_id,signal_id,action,parsed_data,attempts,max_attempts')
        .eq('status', 'pending')
        .lte('next_run_at', nowIso)
        .order('next_run_at', { ascending: true })
        .limit(BATCH_SIZE)
      if (error || !(rows?.length)) return

      for (const job of rows as MgmtJob[]) {
        await this.processOne(job)
      }
    } finally {
      this.running = false
    }
  }

  private async processOne(job: MgmtJob) {
    // cheap claim (single worker today; still prevents duplicate loop picks)
    const { data: claim, error: claimErr } = await this.supabase
      .from('management_jobs')
      .update({
        status: 'processing',
        locked_at: new Date().toISOString(),
        locked_by: this.workerId,
        attempts: (job.attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('id,attempts,max_attempts')
      .maybeSingle()
    if (claimErr || !claim) return

    const attempts = Number(claim.attempts ?? 1)
    const maxAttempts = Number(claim.max_attempts ?? job.max_attempts ?? 6)

    try {
      const res = await fetch(EXECUTE_TRADE_URL, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          signal_id: job.signal_id,
          parsed: job.parsed_data,
        }),
      })

      const bodyText = await res.text()
      if (!res.ok) {
        throw new Error(`execute-trade ${res.status}: ${bodyText.slice(0, 400)}`)
      }

      await this.supabase
        .from('management_jobs')
        .update({
          status: 'done',
          locked_at: null,
          locked_by: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const exhausted = attempts >= maxAttempts
      const delayMs = Math.min(5 * 60_000, Math.max(5000, 5000 * Math.pow(2, attempts - 1)))
      const nextRun = new Date(Date.now() + delayMs).toISOString()
      await this.supabase
        .from('management_jobs')
        .update({
          status: exhausted ? 'failed' : 'pending',
          next_run_at: exhausted ? new Date().toISOString() : nextRun,
          last_error: msg.slice(0, 1000),
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id)
      console.error(`[managementWorker] job ${job.id} failed:`, msg)
    }
  }
}

