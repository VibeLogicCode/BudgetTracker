'use client';

import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from '@/components/icons';
import { applyTheme, readStoredTheme, storeTheme, type ThemePreference } from './theme';

const OPTIONS: { value: ThemePreference; label: string; Icon: (props: { className?: string }) => React.ReactElement }[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
];

/**
 * Three-way theme control: light, dark, or follow the device.
 *
 * State starts at 'system' on both server and client so the first client render
 * matches the markup React was given; the stored choice is read in an effect
 * immediately after. The <html> class itself was already set before paint by
 * ThemeScript, so this component never causes the visible theme to change on
 * hydration — it only catches the segmented control up.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [preference, setPreference] = useState<ThemePreference>('system');

  useEffect(() => {
    setPreference(readStoredTheme());
  }, []);

  // Following the device means following it live, not just at page load.
  useEffect(() => {
    if (preference !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  function choose(next: ThemePreference) {
    setPreference(next);
    storeTheme(next);
    applyTheme(next);
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={`inline-flex items-center gap-0.5 rounded-full border border-line bg-surface-2 p-0.5 ${className}`}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => choose(value)}
            aria-pressed={active}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            // 2026-09-15: min-h-11/min-w-11 below `sm`, the same 44px floor PillNav, MonthNav and
            // .field-control already keep. At p-1.5 these were ~28px -- three small targets in a
            // row, on the control a phone user reaches for most often after the menu.
            className={`btn btn--ghost min-h-11 min-w-11 rounded-full p-1.5 sm:min-h-0 sm:min-w-0 ${
              active ? 'bg-surface text-accent-text shadow-flat' : 'text-subtle hover:text-ink'
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
