export const fmtTok = (n: number) =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`

export const bar = (pct: number, width = 20) => {
  const full = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

export const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export const clock = (iso: string) => iso.slice(11, 19)

export const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))
