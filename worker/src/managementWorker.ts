import { SupabaseClient } from '@supabase/supabase-js'

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

/**
 * Drains legacy `management_jobs` rows. Broker execution was removed; jobs are
 * closed so the queue does not grow forever from older signals.
 */
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
    this.tick().catch(err => console.error('[managementWorker] initial tick failed:', err))
    console.log(`[managementWorker] started (job drain only, poll=${POLL_MS}ms batch=${BATCH_SIZE})`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick() {
    if (this.running) return
    this.running = true
    try {
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
      .select('id')
      .maybeSingle()
    if (claimErr || !claim) return

    await this.supabase
      .from('management_jobs')
      .update({
        status: 'done',
        last_error: 'Broker execution removed; instruction is on signals.parsed_data only.',
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  }
}
