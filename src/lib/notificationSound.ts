let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  if (!audioContext) audioContext = new Ctx()
  return audioContext
}

function resumeContext(ctx: AudioContext): void {
  if (ctx.state === 'suspended') void ctx.resume()
}

/** Short trade-notification chime via Web Audio (no asset file). */
export function playNotificationSound(): void {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    resumeContext(ctx)

    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.08)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.24)
  } catch {
    // Autoplay or audio API unavailable — ignore
  }
}

/**
 * Soft two-note “message” chime for support chat — distinct from trade alerts.
 * Ascending triangle tones (C6 → E6), quieter and slightly longer.
 */
export function playSupportNotificationSound(): void {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    resumeContext(ctx)

    const now = ctx.currentTime
    const notes = [
      { freq: 1046.5, start: 0, dur: 0.14 },
      { freq: 1318.5, start: 0.12, dur: 0.2 },
    ]

    for (const note of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(note.freq, now + note.start)
      const t0 = now + note.start
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + note.dur + 0.02)
    }
  } catch {
    // Autoplay or audio API unavailable — ignore
  }
}
