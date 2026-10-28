// Small SVG time-series chart: 2px lines, hairline grid, crosshair + tooltip that lists every
// series at the hovered time, direct end labels. One y-axis only; series share a unit.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export interface Series {
  key: string
  label: string
  /** CSS custom property holding the series color, e.g. var(--series-1) */
  color: string
  points: { t: number; v: number }[]
}

interface Props {
  title: string
  unit: string
  series: Series[]
  format: (v: number) => string
  height?: number
}

const PAD = { top: 12, right: 56, bottom: 24, left: 40 }

export function TrendChart({ title, unit, series, format, height = 180 }: Props) {
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const titleId = useId()

  const model = useMemo(() => {
    const all = series.flatMap((s) => s.points)
    if (all.length === 0) return null
    const t0 = Math.min(...all.map((p) => p.t))
    const t1 = Math.max(...all.map((p) => p.t))
    const vMin = Math.min(...all.map((p) => p.v))
    const vMax = Math.max(...all.map((p) => p.v))
    const ticks = niceTicks(vMin, vMax, 4)
    const lo = ticks[0]
    const hi = ticks[ticks.length - 1]
    const w = Math.max(width - PAD.left - PAD.right, 10)
    const h = height - PAD.top - PAD.bottom
    const x = (t: number) => PAD.left + (t1 === t0 ? w / 2 : ((t - t0) / (t1 - t0)) * w)
    const y = (v: number) => PAD.top + h - ((v - lo) / (hi - lo || 1)) * h
    const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b)
    return { t0, t1, ticks, x, y, times }
  }, [series, width, height])

  const empty = model === null
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [empty])

  if (!model) return null
  const { ticks, x, y, times, t0, t1 } = model
  const hoverT = hover === null ? null : times[hover]

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    let best = 0
    for (let i = 1; i < times.length; i++) if (Math.abs(x(times[i]) - px) < Math.abs(x(times[best]) - px)) best = i
    setHover(best)
  }

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min((h ?? -1) + 1, times.length - 1))
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max((h ?? times.length) - 1, 0))
    else if (e.key === 'Escape') setHover(null)
    else return
    e.preventDefault()
  }

  const tooltipLeft = hoverT === null ? 0 : Math.min(Math.max(x(hoverT) - 70, 0), width - 150)

  return (
    <figure className="chart">
      <figcaption id={titleId}>
        <span className="chart-title">{title}</span>
        <span className="chart-unit">{unit}</span>
        {series.length > 1 && (
          <span className="legend">
            {series.map((s) => (
              <span key={s.key} className="legend-item">
                <svg width="14" height="4" aria-hidden="true">
                  <line x1="0" y1="2" x2="14" y2="2" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
                </svg>
                {s.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="chart-plot">
        <svg
          ref={ref}
          width="100%"
          height={height}
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} />
              <text className="tick" x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
                {formatTick(v)}
              </text>
            </g>
          ))}
          <text className="tick" x={PAD.left} y={height - 6}>
            {shortDate(t0)}
          </text>
          {t1 !== t0 && (
            <text className="tick" x={width - PAD.right} y={height - 6} textAnchor="end">
              {shortDate(t1)}
            </text>
          )}
          {series.map((s) => {
            const pts = [...s.points].sort((a, b) => a.t - b.t)
            const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
            const last = pts.at(-1)
            return (
              <g key={s.key}>
                <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {pts.length <= 40 &&
                  pts.map((p) => <circle key={p.t} className="dot" cx={x(p.t)} cy={y(p.v)} r="3" fill={s.color} />)}
                {last && (
                  <>
                    <circle className="dot" cx={x(last.t)} cy={y(last.v)} r="4" fill={s.color} />
                    <text className="end-label" x={x(last.t) + 8} y={y(last.v)} dy="0.32em">
                      {format(last.v)}
                    </text>
                  </>
                )}
              </g>
            )
          })}
          {hoverT !== null && (
            <line className="crosshair" x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={height - PAD.bottom} />
          )}
        </svg>
        {hoverT !== null && (
          <div className="tooltip" style={{ left: tooltipLeft }} role="status">
            <div className="tooltip-time">{new Date(hoverT).toLocaleString()}</div>
            {series.map((s) => {
              const p = s.points.find((q) => q.t === hoverT)
              if (!p) return null
              return (
                <div key={s.key} className="tooltip-row">
                  <svg width="12" height="4" aria-hidden="true">
                    <line x1="0" y1="2" x2="12" y2="2" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <strong>{format(p.v)}</strong>
                  <span>{s.label}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </figure>
  )
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1
    min -= pad
    max += pad
  }
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(6)))
  return out
}

function formatTick(v: number) {
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function shortDate(t: number) {
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
