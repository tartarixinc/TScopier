import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import clsx from 'clsx'

/** One full pass along the wire (3× faster than the original 2.8s loop). */
const FLOW_DURATION_S = 2.8 / 3

function pulseDelay(pathFraction: number): number {
  return (pathFraction - 0.5) * FLOW_DURATION_S
}

const NODES = [
  { src: '/Telegram.svg', alt: 'Telegram', hub: false, className: 'hero-platform-flow__node--telegram' },
  { src: '/tslogo-collapse.png', alt: 'TScopier', hub: true, className: 'hero-platform-flow__node--hub' },
  { src: '/MT5.png', alt: 'MetaTrader 5', hub: false, className: 'hero-platform-flow__node--broker' },
] as const

type Point = { x: number; y: number }

function measureNodeCenters(container: HTMLElement, nodes: (HTMLDivElement | null)[]): Point[] | null {
  const rect = container.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null

  const points: Point[] = []
  for (const node of nodes) {
    if (!node) return null
    const nr = node.getBoundingClientRect()
    points.push({
      x: nr.left + nr.width / 2 - rect.left,
      y: nr.top + nr.height / 2 - rect.top,
    })
  }
  return points
}

function buildHorizontalPath(points: Point[]): { points: Point[]; path: string } {
  const y = points.reduce((sum, p) => sum + p.y, 0) / points.length
  const aligned = points.map(p => ({ x: p.x, y }))
  const [first, ...rest] = aligned
  const path = `M ${first.x} ${first.y}${rest.map(p => ` L ${p.x} ${p.y}`).join('')}`
  return { points: aligned, path }
}

/** When the traveler hits the center logo (0–1 along the path). */
function hubPathFraction(points: Point[]): number {
  if (points.length < 3) return 0.5
  const total = Math.abs(points[points.length - 1].x - points[0].x)
  if (total < 1) return 0.5
  return Math.abs(points[1].x - points[0].x) / total
}

export function HeroPlatformFlow() {
  const containerRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef<(HTMLDivElement | null)[]>([])
  const [reduceMotion, setReduceMotion] = useState(false)
  const [geometry, setGeometry] = useState<{
    width: number
    height: number
    points: Point[]
    path: string
    cssPath: string
    telegramDelayS: number
    hubDelayS: number
    mt5DelayS: number
  } | null>(null)

  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const raw = measureNodeCenters(container, nodeRefs.current)
    if (!raw) return

    const rect = container.getBoundingClientRect()
    const { points, path } = buildHorizontalPath(raw)
    const hubAt = hubPathFraction(points)

    setGeometry({
      width: rect.width,
      height: rect.height,
      points,
      path,
      cssPath: `path('${path}')`,
      telegramDelayS: pulseDelay(0),
      hubDelayS: pulseDelay(hubAt),
      mt5DelayS: pulseDelay(1),
    })
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduceMotion(mq.matches)
    const onChange = () => setReduceMotion(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useLayoutEffect(() => {
    measure()
    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver(() => measure())
    ro.observe(container)
    for (const node of nodeRefs.current) {
      if (node) ro.observe(node)
    }
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  return (
    <div
      ref={containerRef}
      className="hero-platform-flow"
      role="img"
      aria-label="Signals flow from Telegram through TScopier to MetaTrader 5"
      style={
        geometry
          ? ({
              '--hero-flow-path': geometry.cssPath,
              '--hero-flow-duration': `${FLOW_DURATION_S}s`,
              '--hero-flow-telegram-delay': `${geometry.telegramDelayS}s`,
              '--hero-flow-hub-delay': `${geometry.hubDelayS}s`,
              '--hero-flow-mt5-delay': `${geometry.mt5DelayS}s`,
            } as CSSProperties)
          : undefined
      }
    >
      {geometry ? (
        <>
          <svg
            className="hero-platform-flow__svg"
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            width={geometry.width}
            height={geometry.height}
            aria-hidden
          >
            <path d={geometry.path} className="hero-platform-flow__wire-base" fill="none" />
            {geometry.points.map((point, i) => (
              <circle
                key={NODES[i].src}
                cx={point.x}
                cy={point.y}
                r="1"
                className="hero-platform-flow__anchor"
              />
            ))}
          </svg>

          <span
            className={clsx(
              'hero-platform-flow__traveler',
              reduceMotion && 'hero-platform-flow__traveler--static',
            )}
            aria-hidden
          />
        </>
      ) : null}

      <div className="hero-platform-flow__nodes">
        {NODES.map((node, index) => (
          <div
            key={node.src}
            ref={(el) => {
              nodeRefs.current[index] = el
            }}
            className={clsx('hero-platform-flow__node', node.className)}
          >
            <img
              src={node.src}
              alt={node.alt}
              className="hero-platform-flow__node-img"
              width={node.hub ? 20 : 16}
              height={node.hub ? 20 : 16}
              draggable={false}
              onLoad={measure}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
