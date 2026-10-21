import { useEffect, useRef } from 'react'
import { DateTime } from 'luxon'
import { isNightAt } from '@shared/sun'
import { isInSleepWindow } from '@shared/sleepWindow'
import type { AppSettings } from '@shared/types'
import { useSettings } from '../api/hooks'
import { ZONE } from '../stores/uiStore'

function applyTheme(settings: AppSettings | undefined): void {
  // do nothing until settings load — applying the 'auto' fallback early would
  // flash the wrong theme for users with an explicit light/dark choice
  if (!settings) return
  const weather = settings.weather ? { lat: settings.weather.lat, lon: settings.weather.lon } : null
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'auto' && isNightAt(DateTime.now().setZone(ZONE), weather))
  document.documentElement.classList.toggle('dark', dark)
  // night dimming: brightness filter during the configured window, independent
  // of theme — a hallway display shouldn't blaze at 3am
  const nd = settings.nightDimming
  const now = DateTime.now().setZone(ZONE)
  const inWindow = nd.enabled && isInSleepWindow(now.hour * 60 + now.minute, nd.start, nd.end)
  document.documentElement.style.filter = inWindow ? `brightness(${nd.level}%)` : ''
}

/**
 * Applies the theme to <html>. 'auto' follows the sun at the configured
 * weather location (computed locally — no network). The minute re-check runs
 * outside React state so the app tree is NOT re-rendered every tick.
 */
export function useTheme(): void {
  const { data: settings } = useSettings()
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => {
    applyTheme(settings)
    // both 'auto' theme and night dimming change with the clock
    if (settings?.theme !== 'auto' && !settings?.nightDimming.enabled) return
    const timer = setInterval(() => applyTheme(settingsRef.current), 60_000)
    return () => clearInterval(timer)
  }, [settings])
}
