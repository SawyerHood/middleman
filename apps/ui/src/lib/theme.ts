export type ThemePreference = 'light' | 'dark' | 'auto'

export const THEME_STORAGE_KEY = 'middleman-theme'

const DARK_CLASS_NAME = 'dark'
const SYSTEM_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)'

let removeSystemThemeListener: (() => void) | null = null

export const THEME_INIT_SCRIPT = `(() => {
  try {
    const storageKey = '${THEME_STORAGE_KEY}';
    const darkClass = '${DARK_CLASS_NAME}';
    const stored = window.localStorage.getItem(storageKey);
    const preference = stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';

    if (preference === 'dark') {
      document.documentElement.classList.add(darkClass);
      return;
    }

    if (preference === 'light') {
      document.documentElement.classList.remove(darkClass);
      return;
    }

    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('${SYSTEM_THEME_MEDIA_QUERY}').matches;

    document.documentElement.classList.toggle(darkClass, prefersDark);
  } catch {
    document.documentElement.classList.remove('${DARK_CLASS_NAME}');
  }
})();`

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'auto'
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') {
    return 'auto'
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

function applyDarkClass(isDark: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(DARK_CLASS_NAME, isDark)
}

function clearSystemThemeListener(): void {
  if (!removeSystemThemeListener) return
  removeSystemThemeListener()
  removeSystemThemeListener = null
}

function attachSystemThemeListener(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    applyDarkClass(false)
    return
  }

  const mediaQuery = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY)
  const applyCurrentSystemTheme = (): void => {
    applyDarkClass(mediaQuery.matches)
  }

  applyCurrentSystemTheme()
  const handleChange = (): void => {
    applyCurrentSystemTheme()
  }

  mediaQuery.addEventListener('change', handleChange)
  removeSystemThemeListener = () => {
    mediaQuery.removeEventListener('change', handleChange)
  }
}

export function applyThemePreference(
  preference: ThemePreference,
  options: { persist?: boolean } = {},
): void {
  if (typeof window === 'undefined') return

  const { persist = true } = options

  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference)
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  }

  clearSystemThemeListener()

  if (preference === 'light') {
    applyDarkClass(false)
    return
  }

  if (preference === 'dark') {
    applyDarkClass(true)
    return
  }

  attachSystemThemeListener()
}

export function initializeThemePreference(): ThemePreference {
  const preference = readStoredThemePreference()
  applyThemePreference(preference, { persist: false })
  return preference
}
