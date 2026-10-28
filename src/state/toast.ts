import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'error'
}

let toasts: Toast[] = []
let next = 1
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = next++
  toasts = [...toasts, { id, text, tone }]
  emit()
  setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000)
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => toasts,
  )
}
