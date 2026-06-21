/**
 * Per-channel "layer till close" — keep virtual range pendings active until the
 * whole basket is flat (ON), or freeze layering after first TP/CWE close (OFF).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveChannelTradingConfig } from './channelTradingConfig'
import { deleteRangePendingLegsForBasket } from './rangePendingLegDelete'
import {
  countOpenTradesForBasket,
  setTpTouchedLock,
  type RangePendingTpLockScope,
} from './rangePendingFireGuard'
import type { ManualSettings } from './manualPlanning/types'

export type RangeLayerBasketScope = RangePendingTpLockScope & {
  userId?: string | null
}

export function isRangeLayerTillCloseEnabled(
  settings: ManualSettings | Record<string, unknown> | null | undefined,
): boolean {
  if (!settings || typeof settings !== 'object') return false
  return (settings as ManualSettings).range_layer_till_close === true
}

export async function loadRangeLayerTillCloseForSignal(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
): Promise<boolean> {
  const { data: signal, error: signalErr } = await supabase
    .from('signals')
    .select('channel_id')
    .eq('id', signalId)
    .maybeSingle()
  if (signalErr) {
    console.warn(
      `[rangeLayerTillClose] signal lookup failed signal=${signalId}: ${signalErr.message}`,
    )
    return false
  }

  const { data: broker, error: brokerErr } = await supabase
    .from('broker_accounts')
    .select('manual_settings, channel_trading_configs, copier_mode, ai_settings, signal_channel_ids')
    .eq('id', brokerAccountId)
    .maybeSingle()
  if (brokerErr || !broker) {
    console.warn(
      `[rangeLayerTillClose] broker lookup failed broker=${brokerAccountId}: ${brokerErr?.message ?? 'missing'}`,
    )
    return false
  }

  const channelId = (signal as { channel_id?: string | null } | null)?.channel_id ?? null
  const resolved = resolveChannelTradingConfig(broker, channelId)
  return isRangeLayerTillCloseEnabled(resolved.manual_settings)
}

/** Delete active pendings and set basket lock (layering stopped). */
export async function freezeRangeLayeringForBasket(
  supabase: SupabaseClient,
  scope: RangeLayerBasketScope,
  reason = 'layering_stopped',
): Promise<void> {
  if (!scope.userId) return
  await setTpTouchedLock(supabase, {
    signalId: scope.signalId,
    brokerAccountId: scope.brokerAccountId,
    symbol: scope.symbol,
    userId: scope.userId,
    lockReason: reason,
  })
}

/**
 * When layer till close is OFF: delete pending legs and freeze further layering.
 * When ON: no-op.
 */
export async function stopRangeLayeringUnlessEnabled(
  supabase: SupabaseClient,
  scope: RangeLayerBasketScope,
  reason: string,
): Promise<{ stopped: boolean; deleted: number }> {
  const layerTillClose = await loadRangeLayerTillCloseForSignal(
    supabase,
    scope.signalId,
    scope.brokerAccountId,
  )
  if (layerTillClose) return { stopped: false, deleted: 0 }

  const openCount = await countOpenTradesForBasket(
    supabase,
    scope.signalId,
    scope.brokerAccountId,
  )
  if (openCount <= 0) return { stopped: false, deleted: 0 }

  const deleted = await deleteRangePendingLegsForBasket(
    supabase,
    { signalId: scope.signalId, brokerAccountId: scope.brokerAccountId },
    reason,
  )
  await freezeRangeLayeringForBasket(supabase, scope, reason)
  return { stopped: true, deleted }
}
