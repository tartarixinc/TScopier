import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts'
import { Loader2, Pause, Play } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { backtestApi } from '../../lib/backtestApi'
import type { BacktestTradeReplayResponse, BacktestTradeRow } from '../../lib/backtestTypes'
import { backtestDisplayLabels, formatDurationMs, formatEntryPrice } from '../../lib/backtestDisplay'
import { LOSS_COLOR } from '../../lib/pnlDisplay'

interface BacktestTradeReplayChartProps {
  trade: BacktestTradeRow
}

const SPEEDS = [1, 2, 4] as const

function isDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function chartTheme(dark: boolean) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: dark ? '#171717' : '#fafafa' },
      textColor: dark ? '#a3a3a3' : '#525252',
    },
    grid: {
      vertLines: { color: dark ? '#262626' : '#e5e5e5' },
      horzLines: { color: dark ? '#262626' : '#e5e5e5' },
    },
    crosshair: { mode: CrosshairMode.Normal },
  }
}

function candleColors(dark: boolean) {
  return {
    upColor: dark ? '#14b8a6' : '#0d9488',
    downColor: dark ? '#ef4444' : '#dc2626',
    borderUpColor: dark ? '#0f766e' : '#0f766e',
    borderDownColor: dark ? '#b91c1c' : '#b91c1c',
    wickUpColor: dark ? '#14b8a6' : '#0d9488',
    wickDownColor: dark ? '#ef4444' : '#dc2626',
  }
}

function toChartCandles(candles: BacktestTradeReplayResponse['candles']) {
  const byTime = new Map<number, (typeof candles)[number]>()
  for (const c of candles) {
    byTime.set(c.time, c)
  }
  return [...byTime.values()]
    .sort((a, b) => a.time - b.time)
    .map(c => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))
}

export function BacktestTradeReplayChart({ trade }: BacktestTradeReplayChartProps) {
  const t = useT()
  const bt = t.backtest
  const labels = backtestDisplayLabels(bt)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const replayRef = useRef<BacktestTradeReplayResponse | null>(null)
  const playTimerRef = useRef<number | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [replay, setReplay] = useState<BacktestTradeReplayResponse | null>(null)
  const [visibleCount, setVisibleCount] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(0)

  const stopPlay = useCallback(() => {
    if (playTimerRef.current != null) {
      window.clearInterval(playTimerRef.current)
      playTimerRef.current = null
    }
    setPlaying(false)
  }, [])

  const applyVisible = useCallback((count: number, data: BacktestTradeReplayResponse) => {
    const series = seriesRef.current
    const chart = chartRef.current
    if (!series || !chart) return
    const all = toChartCandles(data.candles)
    const slice = all.slice(0, Math.max(1, count))
    series.setData(slice)
    chart.timeScale().fitContent()
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setReplay(null)
    setVisibleCount(0)
    stopPlay()

    backtestApi.clearTradeReplayCache(trade.id)
    void backtestApi.getTradeReplay(trade.id)
      .then(data => {
        if (cancelled) return
        replayRef.current = data
        setReplay(data)
        setVisibleCount(data.candles.length)
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : bt.replayError)
        setLoading(false)
      })

    return () => {
      cancelled = true
      stopPlay()
    }
  }, [trade.id, bt.replayError, stopPlay])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !replay?.candles.length) return

    const dark = isDarkMode()
    const chart = createChart(el, {
      width: el.clientWidth,
      height: 260,
      ...chartTheme(dark),
      rightPriceScale: { borderColor: dark ? '#404040' : '#d4d4d4' },
      timeScale: {
        borderColor: dark ? '#404040' : '#d4d4d4',
        timeVisible: true,
        secondsVisible: true,
        barSpacing: 8,
        minBarSpacing: 4,
      },
    })
    const series = chart.addSeries(CandlestickSeries, candleColors(dark))
    chartRef.current = chart
    seriesRef.current = series

    const { markers } = replay
    const pl = labels.priceLevels
    series.createPriceLine({
      price: markers.entry.price,
      color: dark ? '#d4d4d4' : '#525252',
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: pl.entry,
    })
    if (markers.sl != null) {
      series.createPriceLine({
        price: markers.sl,
        color: LOSS_COLOR,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: pl.sl,
      })
    }
    markers.tps.forEach((tp, i) => {
      series.createPriceLine({
        price: tp,
        color: dark ? '#2dd4bf' : '#0d9488',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: pl.tp.replace('{n}', String(i + 1)),
      })
    })

    const chartMarkers: SeriesMarker<UTCTimestamp>[] = [
      {
        time: markers.entry.time as UTCTimestamp,
        position: 'inBar',
        color: dark ? '#d4d4d4' : '#525252',
        shape: 'circle',
        text: pl.entry,
      },
    ]
    if (markers.exit) {
      chartMarkers.push({
        time: markers.exit.time as UTCTimestamp,
        position: 'inBar',
        color: dark ? '#2dd4bf' : '#0d9488',
        shape: 'circle',
        text: bt.replayExit,
      })
    }
    for (const ev of markers.tpEvents) {
      chartMarkers.push({
        time: Math.floor(ev.ts / 1000) as UTCTimestamp,
        position: 'aboveBar',
        color: dark ? '#2dd4bf' : '#0d9488',
        shape: 'arrowDown',
        text: pl.tp.replace('{n}', String(ev.index)),
      })
    }
    createSeriesMarkers(series, chartMarkers.sort((a, b) => a.time - b.time))

    applyVisible(replay.candles.length, replay)

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild chart when replay payload arrives
  }, [replay, labels.priceLevels])

  useEffect(() => {
    if (!replay) return
    applyVisible(visibleCount, replay)
  }, [visibleCount, replay, applyVisible])

  useEffect(() => {
    if (!playing || !replay) return
    const speed = SPEEDS[speedIdx] ?? 1
    const intervalMs = Math.max(80, 400 / speed)
    playTimerRef.current = window.setInterval(() => {
      setVisibleCount(prev => {
        if (prev >= replay.candles.length) {
          stopPlay()
          return prev
        }
        return prev + 1
      })
    }, intervalMs)
    return () => {
      if (playTimerRef.current != null) {
        window.clearInterval(playTimerRef.current)
        playTimerRef.current = null
      }
    }
  }, [playing, replay, speedIdx, stopPlay])

  const togglePlay = () => {
    if (!replay?.candles.length) return
    if (playing) {
      stopPlay()
      return
    }
    if (visibleCount >= replay.candles.length) {
      setVisibleCount(1)
    }
    setPlaying(true)
  }

  const maxCandles = replay?.candles.length ?? 0
  const sourceLabel = replay?.source === 'ticks' ? bt.replaySourceTicks : bt.replaySourceBars

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-900/50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
          {bt.replayTitle}
        </p>
        {replay ? (
          <span className="text-[10px] text-neutral-500 tabular-nums">
            {sourceLabel}
            {' · '}
            {formatDurationMs(replay.tradeDurationMs)}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-52 text-neutral-500 gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">{bt.replayLoading}</span>
        </div>
      ) : error ? (
        <p className="text-sm text-neutral-500 text-center py-12">{error}</p>
      ) : (
        <>
          <div ref={containerRef} className="w-full h-[260px] rounded-lg overflow-hidden" />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={togglePlay}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-750"
            >
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {playing ? bt.replayPause : bt.replayPlay}
            </button>

            <div className="flex items-center gap-1">
              {SPEEDS.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpeedIdx(i)}
                  className={clsx(
                    'px-2 py-1 rounded text-[10px] font-medium tabular-nums border',
                    speedIdx === i
                      ? 'bg-teal-50 border-teal-200 text-teal-700 dark:bg-teal-950/40 dark:border-teal-800 dark:text-teal-300'
                      : 'bg-white dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 text-neutral-500',
                  )}
                >
                  {s}x
                </button>
              ))}
            </div>

            {maxCandles > 1 ? (
              <input
                type="range"
                min={1}
                max={maxCandles}
                value={Math.min(visibleCount, maxCandles)}
                onChange={e => {
                  stopPlay()
                  setVisibleCount(Number(e.target.value))
                }}
                className="flex-1 min-w-[80px] accent-teal-600"
                aria-label={bt.replayScrub}
              />
            ) : null}
          </div>

          {replay?.markers.exit ? (
            <p className="text-[10px] text-neutral-500 tabular-nums">
              {bt.replayExit}: {formatEntryPrice(replay.markers.exit.price)}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
