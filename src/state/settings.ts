import { useLiveQuery } from 'dexie-react-hooks'
import { db, setSetting } from '../db'
import { DEFAULT_UNITS, type UnitPrefs } from '../units'

export function useSetting<T>(key: string, fallback: T): [T, (value: T) => Promise<void>] {
  const row = useLiveQuery(() => db.settings.get(key), [key])
  const value = row === undefined ? fallback : (row.value as T)
  return [value, (v: T) => setSetting(key, v)]
}

export function useUnits(): [UnitPrefs, (u: UnitPrefs) => Promise<void>] {
  const [units, setUnits] = useSetting<UnitPrefs>('units', DEFAULT_UNITS)
  return [{ ...DEFAULT_UNITS, ...units }, setUnits]
}
