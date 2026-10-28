// Inline 16px stroke icons (no icon font, works offline).

import type { ReactNode } from 'react'

function Icon({ children, size = 16, label }: { children: ReactNode; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  )
}

export const BluetoothIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="m7 7 10 10-5 5V2l5 5L7 17" />
  </Icon>
)
export const CheckIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
)
export const AlertIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </Icon>
)
export const ClockIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
)
export const PlugOffIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M2 2l20 20M9 2v4M15 2v4M6 8h9M19 8v3a7 7 0 0 1-1.2 3.9M12 21v-3M8.4 16.7A7 7 0 0 1 5 11V8" />
  </Icon>
)
export const BatteryIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <rect x="2" y="7" width="16" height="10" rx="2" />
    <path d="M22 11v2" />
  </Icon>
)
export const TrashIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
  </Icon>
)
export const PlusIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
export const UploadIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
  </Icon>
)
export const DownloadIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />
  </Icon>
)
export const PlayIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M7 4v16l13-8Z" />
  </Icon>
)
export const InfoIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
)
export const SpinnerIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path className="spin" d="M21 12a9 9 0 1 1-6.2-8.6" />
  </Icon>
)
