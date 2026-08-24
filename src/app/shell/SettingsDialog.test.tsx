import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { LocaleProvider, LOCALE_STORAGE_KEY } from "../../i18n/locale";
import { DEFAULT_READING_PREFERENCES } from "../../reading/preferences";
import { SettingsDialog } from "./SettingsDialog";

it("changes the application language immediately and persists the choice", async () => {
  const onClose = vi.fn();
  render(
    <LocaleProvider installerHint="zh-CN">
      <SettingsDialog
        onClose={onClose}
        onReadingPreferencesChange={vi.fn()}
        readingPreferences={DEFAULT_READING_PREFERENCES}
      />
    </LocaleProvider>,
  );

  expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "English" }));

  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
  await userEvent.click(screen.getByRole("button", { name: "Reading" }));
  expect(screen.getByRole("group", { name: "App Theme" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Warm Paper" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("changes reading appearance immediately from the Reading page", async () => {
  const onReadingPreferencesChange = vi.fn();
  render(
    <LocaleProvider installerHint="zh-CN">
      <SettingsDialog
        initialPage="reading"
        onClose={vi.fn()}
        onReadingPreferencesChange={onReadingPreferencesChange}
        readingPreferences={DEFAULT_READING_PREFERENCES}
      />
    </LocaleProvider>,
  );

  expect(screen.getByRole("button", { name: "阅读" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("group", { name: "应用主题" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "暖纸" }));

  expect(onReadingPreferencesChange).toHaveBeenCalledWith({
    ...DEFAULT_READING_PREFERENCES,
    theme: "warm-paper",
  });
});
