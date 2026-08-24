import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { formatMessage, type MessageKey, type UiLocale } from "./messages";

export const LOCALE_STORAGE_KEY = "markdown-document-app:ui-locale:v1";

export function isUiLocale(value: unknown): value is UiLocale {
  return value === "zh-CN" || value === "en-US";
}

export function resolveInitialLocale({
  stored,
  installerHint,
  systemLanguage,
}: {
  stored: unknown;
  installerHint: UiLocale | null;
  systemLanguage: string;
}): UiLocale {
  if (isUiLocale(stored)) return stored;
  if (installerHint) return installerHint;
  if (typeof systemLanguage !== "string" || systemLanguage.length === 0) return "zh-CN";
  return /^zh(?:-|$)/i.test(systemLanguage) ? "zh-CN" : "en-US";
}

interface LocaleContextValue {
  locale: UiLocale;
  setLocale(locale: UiLocale): void;
  t(key: MessageKey, values?: Readonly<Record<string, string | number>>): string;
}

const fallbackLocale: LocaleContextValue = {
  locale: "zh-CN",
  setLocale: () => undefined,
  t: (key, values) => formatMessage("zh-CN", key, values),
};

const LocaleContext = createContext<LocaleContextValue>(fallbackLocale);

function storedLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function LocaleProvider({
  children,
  installerHint = null,
}: {
  children: ReactNode;
  installerHint?: UiLocale | null;
}) {
  const [locale, setLocaleState] = useState<UiLocale>(() => resolveInitialLocale({
    stored: storedLocale(),
    installerHint,
    systemLanguage: navigator.language,
  }));

  useEffect(() => {
    if (isUiLocale(storedLocale())) return;
    setLocaleState(resolveInitialLocale({
      stored: null,
      installerHint,
      systemLanguage: navigator.language,
    }));
  }, [installerHint]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: UiLocale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // A blocked storage backend should not block the in-memory language change.
    }
  }, []);
  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
    t: (key, values) => formatMessage(locale, key, values),
  }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
