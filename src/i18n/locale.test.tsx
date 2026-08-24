import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import {
  LOCALE_STORAGE_KEY,
  LocaleProvider,
  resolveInitialLocale,
  useLocale,
} from "./locale";
import { enUSMessages, zhCNMessages } from "./messages";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = "";
});

function Probe() {
  const { locale, setLocale, t } = useLocale();
  return <div>
    <span>{locale}</span>
    <span>{t("menu.file")}</span>
    <button onClick={() => setLocale("en-US")} type="button">English</button>
  </div>;
}

describe("UI locale", () => {
  it("keeps the Chinese and English catalogs structurally identical", () => {
    expect(Object.keys(enUSMessages).sort()).toEqual(Object.keys(zhCNMessages).sort());
  });

  it("prefers an explicit setting, then installer language, then system language", () => {
    expect(resolveInitialLocale({
      stored: "en-US",
      installerHint: "zh-CN",
      systemLanguage: "zh-CN",
    })).toBe("en-US");
    expect(resolveInitialLocale({
      stored: null,
      installerHint: "zh-CN",
      systemLanguage: "en-GB",
    })).toBe("zh-CN");
    expect(resolveInitialLocale({
      stored: "broken",
      installerHint: null,
      systemLanguage: "en-GB",
    })).toBe("en-US");
  });

  it("switches immediately, persists the explicit choice, and updates html lang", async () => {
    render(<LocaleProvider installerHint="zh-CN"><Probe /></LocaleProvider>);
    expect(screen.getByText("zh-CN")).toBeInTheDocument();
    expect(screen.getByText("文件")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("zh-CN");

    await userEvent.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByText("en-US")).toBeInTheDocument();
    expect(screen.getByText("File")).toBeInTheDocument();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
  });
});
