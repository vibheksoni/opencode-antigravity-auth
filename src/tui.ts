import type { TuiDialogSelectOption } from "@opencode-ai/plugin/tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ANTIGRAVITY_PROVIDER_ID } from "./constants";
import {
  clearAccounts,
  loadAccounts,
  saveAccounts,
  saveAccountsReplace,
  type AccountMetadataV3,
  type AccountStorageV4,
} from "./plugin/storage";
import { checkAccountsQuota } from "./plugin/quota";
import { getOpencodeConfigPath, updateOpencodeConfig } from "./plugin/config/updater";
import { verifyAccountAccess } from "./plugin/verification";
import { DEFAULT_CONFIG } from "./plugin/config/schema";

const TUI_PLUGIN_ID = "opencode-antigravity-auth:tui";
const COMMAND_OPEN = "antigravity.accounts";
const COMMAND_RELOAD = "antigravity.accounts.reload";

type TuiApi = any;

function accountStatus(now: number, account: any): string {
  if (account.enabled === false) return "disabled";
  if (account.verificationRequired) return "verification-required";
  const limits = account.rateLimitResetTimes;
  if (limits && typeof limits === "object") {
    for (const value of Object.values(limits)) {
      if (typeof value === "number" && value > now) return "rate-limited";
    }
  }
  return "active";
}

function accountLabel(index: number, account: any, currentIndex: number, now: number): string {
  const email = typeof account.email === "string" && account.email.trim()
    ? account.email
    : `Account ${index + 1}`;
  const status = accountStatus(now, account);
  const tags: string[] = [];
  if (index === currentIndex) tags.push("current");
  tags.push(status);
  return `${index + 1}. ${email} [${tags.join("] [")}]`;
}

async function removeAccountByIndex(index: number): Promise<{ ok: boolean; message: string }> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    return { ok: false, message: "No accounts to remove." };
  }
  if (index < 0 || index >= storage.accounts.length) {
    return { ok: false, message: "Invalid account index." };
  }

  const nextAccounts = storage.accounts.filter((_, i) => i !== index);
  let nextIndex = storage.activeIndex;
  if (nextAccounts.length === 0) {
    nextIndex = 0;
  } else if (index === storage.activeIndex) {
    nextIndex = Math.min(index, nextAccounts.length - 1);
  } else if (index < storage.activeIndex) {
    nextIndex = Math.max(0, storage.activeIndex - 1);
  }

  const next: AccountStorageV4 = {
    version: 4,
    accounts: nextAccounts,
    activeIndex: nextIndex,
    activeIndexByFamily: storage.activeIndexByFamily,
  };

  await saveAccountsReplace(next);
  return { ok: true, message: "Account removed." };
}

async function setCurrentIndex(index: number): Promise<{ ok: boolean; message: string }> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    return { ok: false, message: "No accounts available." };
  }
  if (index < 0 || index >= storage.accounts.length) {
    return { ok: false, message: "Invalid account index." };
  }

  const next: AccountStorageV4 = {
    version: 4,
    accounts: storage.accounts,
    activeIndex: index,
    activeIndexByFamily: storage.activeIndexByFamily,
  };

  await saveAccountsReplace(next);
  return { ok: true, message: `Switched current account to #${index + 1}.` };
}

function createDialogSelect(api: TuiApi, props: any): any {
  return api.ui.DialogSelect(props);
}

function formatWaitTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function formatReset(resetTime?: string): string {
  if (!resetTime) return "";
  const ms = Date.parse(resetTime) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return " (resetting)";
  return ` (resets in ${formatWaitTime(ms)})`;
}

function stripJsonCommentsAndTrailingCommas(json: string): string {
  return json
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match: string, group: string | undefined) =>
      group ? "" : match,
    )
    .replace(/,(\s*[}\]])/g, "$1");
}

async function enableLoadBalancerDefaults(): Promise<{ ok: boolean; message: string; path?: string }> {
  const configPath = getOpencodeConfigPath();
  try {
    const raw = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "{}";
    const config = JSON.parse(stripJsonCommentsAndTrailingCommas(raw)) as Record<string, unknown>;

    const pluginValue = config.plugin;
    const pluginList: Array<string | [string, Record<string, unknown>]> = Array.isArray(pluginValue)
      ? [...pluginValue as Array<string | [string, Record<string, unknown>]>]
      : [];

    const settings = {
      account_selection_strategy: "hybrid",
      scheduling_mode: "cache_first",
      pid_offset_enabled: false,
    };

    let found = false;
    for (let i = 0; i < pluginList.length; i++) {
      const entry = pluginList[i];
      if (typeof entry === "string") {
        if (entry.includes("opencode-antigravity-auth")) {
          pluginList[i] = [entry, settings];
          found = true;
          break;
        }
      } else if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].includes("opencode-antigravity-auth")) {
        pluginList[i] = [entry[0], { ...(entry[1] ?? {}), ...settings }];
        found = true;
        break;
      }
    }

    if (!found) {
      pluginList.push(["opencode-antigravity-auth@latest", settings]);
    }

    config.plugin = pluginList;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    return {
      ok: true,
      path: configPath,
      message:
        "Enabled load-balancer defaults: hybrid + cache_first + pid_offset_enabled=false",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

type LoadBalancerSettings = {
  account_selection_strategy: "sticky" | "round-robin" | "hybrid";
  scheduling_mode: "cache_first" | "balance" | "performance_first";
  pid_offset_enabled: boolean;
  switch_on_first_rate_limit: boolean;
  max_rate_limit_wait_seconds: number;
  max_cache_first_wait_seconds: number;
  default_retry_after_seconds: number;
  max_backoff_seconds: number;
  request_jitter_max_ms: number;
  soft_quota_threshold_percent: number;
  quota_refresh_interval_minutes: number;
  cli_first: boolean;
};

const SETTINGS_KEYS: Array<keyof LoadBalancerSettings> = [
  "account_selection_strategy",
  "scheduling_mode",
  "pid_offset_enabled",
  "switch_on_first_rate_limit",
  "max_rate_limit_wait_seconds",
  "max_cache_first_wait_seconds",
  "default_retry_after_seconds",
  "max_backoff_seconds",
  "request_jitter_max_ms",
  "soft_quota_threshold_percent",
  "quota_refresh_interval_minutes",
  "cli_first",
];

function getDefaultLoadBalancerSettings(): LoadBalancerSettings {
  return {
    account_selection_strategy: DEFAULT_CONFIG.account_selection_strategy,
    scheduling_mode: DEFAULT_CONFIG.scheduling_mode,
    pid_offset_enabled: DEFAULT_CONFIG.pid_offset_enabled,
    switch_on_first_rate_limit: DEFAULT_CONFIG.switch_on_first_rate_limit,
    max_rate_limit_wait_seconds: DEFAULT_CONFIG.max_rate_limit_wait_seconds,
    max_cache_first_wait_seconds: DEFAULT_CONFIG.max_cache_first_wait_seconds,
    default_retry_after_seconds: DEFAULT_CONFIG.default_retry_after_seconds,
    max_backoff_seconds: DEFAULT_CONFIG.max_backoff_seconds,
    request_jitter_max_ms: DEFAULT_CONFIG.request_jitter_max_ms,
    soft_quota_threshold_percent: DEFAULT_CONFIG.soft_quota_threshold_percent,
    quota_refresh_interval_minutes: DEFAULT_CONFIG.quota_refresh_interval_minutes,
    cli_first: DEFAULT_CONFIG.cli_first,
  };
}

function normalizeSettingsPatch(input: Record<string, unknown>): Partial<LoadBalancerSettings> {
  const out: Partial<LoadBalancerSettings> = {};
  for (const key of SETTINGS_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof getDefaultLoadBalancerSettings()[key] === "boolean") {
      if (typeof value === "boolean") {
        out[key] = value as never;
      }
      continue;
    }
    if (typeof getDefaultLoadBalancerSettings()[key] === "number") {
      if (typeof value === "number" && Number.isFinite(value)) {
        out[key] = value as never;
      }
      continue;
    }
    if (typeof value === "string") {
      out[key] = value as never;
    }
  }
  return out;
}

function readOpencodeConfig(): { path: string; config: Record<string, unknown> } {
  const path = getOpencodeConfigPath();
  const raw = existsSync(path) ? readFileSync(path, "utf-8") : "{}";
  const config = JSON.parse(stripJsonCommentsAndTrailingCommas(raw)) as Record<string, unknown>;
  return { path, config };
}

function getPluginList(config: Record<string, unknown>): Array<string | [string, Record<string, unknown>]> {
  const pluginValue = config.plugin;
  if (!Array.isArray(pluginValue)) return [];
  return [...(pluginValue as Array<string | [string, Record<string, unknown>]>)];
}

function findAntigravityPluginEntry(pluginList: Array<string | [string, Record<string, unknown>]>): {
  index: number;
  spec: string;
  options: Record<string, unknown>;
} | null {
  for (let i = 0; i < pluginList.length; i++) {
    const entry = pluginList[i];
    if (typeof entry === "string") {
      if (entry.includes("opencode-antigravity-auth")) {
        return { index: i, spec: entry, options: {} };
      }
      continue;
    }
    if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].includes("opencode-antigravity-auth")) {
      return { index: i, spec: entry[0], options: (entry[1] ?? {}) as Record<string, unknown> };
    }
  }
  return null;
}

function loadCurrentSettings(): { settings: LoadBalancerSettings; path: string } {
  const defaults = getDefaultLoadBalancerSettings();
  const { path, config } = readOpencodeConfig();
  const pluginList = getPluginList(config);
  const found = findAntigravityPluginEntry(pluginList);
  if (!found) {
    return { settings: defaults, path };
  }
  const patch = normalizeSettingsPatch(found.options);
  return {
    path,
    settings: {
      ...defaults,
      ...patch,
    },
  };
}

async function writeSettingsPatch(patch: Partial<LoadBalancerSettings>): Promise<{ ok: boolean; path?: string; message: string }> {
  try {
    const { path, config } = readOpencodeConfig();
    const pluginList = getPluginList(config);
    const found = findAntigravityPluginEntry(pluginList);
    const normalizedPatch = normalizeSettingsPatch(patch as Record<string, unknown>);

    if (found) {
      const merged = { ...found.options, ...normalizedPatch };
      pluginList[found.index] = [found.spec, merged];
    } else {
      pluginList.push(["opencode-antigravity-auth@latest", normalizedPatch]);
    }

    config.plugin = pluginList;
    writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
    return { ok: true, path, message: "Settings updated." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function showNumericPrompt(
  api: TuiApi,
  title: string,
  current: number,
  min: number,
  max: number,
  onDone: () => void,
  key: keyof LoadBalancerSettings,
): void {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title,
      value: String(current),
      placeholder: `${min}-${max}`,
      onCancel: onDone,
      onConfirm: (value: string) => {
        const parsed = Number.parseInt(value.trim(), 10);
        if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
          api.ui.toast({ variant: "error", message: `Enter a number between ${min} and ${max}.` });
          return;
        }
        void writeSettingsPatch({ [key]: parsed } as Partial<LoadBalancerSettings>).then((result) => {
          api.ui.toast({
            variant: result.ok ? "success" : "error",
            message: result.ok ? `${title} updated.` : `Failed: ${result.message}`,
          });
          onDone();
        });
      },
    }),
  );
}

function showStrategySelect(api: TuiApi, onDone: () => void): void {
  const { settings } = loadCurrentSettings();
  const options: TuiDialogSelectOption<string>[] = [
    { title: "sticky", value: "sticky", description: "Reuse current account until limited" },
    { title: "round-robin", value: "round-robin", description: "Rotate every request (max distribution)" },
    { title: "hybrid", value: "hybrid", description: "Health + token bucket + freshness" },
    { title: "Back", value: "back", category: "Navigation" },
  ];
  api.ui.dialog.replace(() =>
    createDialogSelect(api, {
      title: "Account Selection Strategy",
      current: settings.account_selection_strategy,
      options,
      onSelect: (item: TuiDialogSelectOption<string>) => {
        if (item.value === "back") {
          onDone();
          return;
        }
        void writeSettingsPatch({ account_selection_strategy: item.value as LoadBalancerSettings["account_selection_strategy"] }).then((result) => {
          api.ui.toast({
            variant: result.ok ? "success" : "error",
            message: result.ok ? "Strategy updated." : `Failed: ${result.message}`,
          });
          onDone();
        });
      },
    }),
  );
}

function showSchedulingSelect(api: TuiApi, onDone: () => void): void {
  const { settings } = loadCurrentSettings();
  const options: TuiDialogSelectOption<string>[] = [
    { title: "cache_first", value: "cache_first", description: "Prefer same account for cache continuity" },
    { title: "balance", value: "balance", description: "Switch accounts sooner under limits" },
    { title: "performance_first", value: "performance_first", description: "Favor throughput and distribution" },
    { title: "Back", value: "back", category: "Navigation" },
  ];
  api.ui.dialog.replace(() =>
    createDialogSelect(api, {
      title: "Scheduling Mode",
      current: settings.scheduling_mode,
      options,
      onSelect: (item: TuiDialogSelectOption<string>) => {
        if (item.value === "back") {
          onDone();
          return;
        }
        void writeSettingsPatch({ scheduling_mode: item.value as LoadBalancerSettings["scheduling_mode"] }).then((result) => {
          api.ui.toast({
            variant: result.ok ? "success" : "error",
            message: result.ok ? "Scheduling mode updated." : `Failed: ${result.message}`,
          });
          onDone();
        });
      },
    }),
  );
}

function showLoadBalancerSettingsDialog(api: TuiApi): void {
  const { settings, path } = loadCurrentSettings();
  const options: TuiDialogSelectOption<string>[] = [
    {
      title: "Preset: Throughput",
      value: "preset:throughput",
      category: "Presets",
      description: "round-robin + performance_first + pid_offset_enabled",
    },
    {
      title: "Preset: Balanced",
      value: "preset:balanced",
      category: "Presets",
      description: "hybrid + balance + pid_offset_enabled",
    },
    {
      title: "Preset: Cache-friendly",
      value: "preset:cache",
      category: "Presets",
      description: "hybrid + cache_first + pid_offset_disabled",
    },
    {
      title: "Preset: Rate-limit hardened",
      value: "preset:rate-limit-hardened",
      category: "Presets",
      description: "cache-friendly + stronger retry/backoff + soft-quota hardening",
    },
    {
      title: `Strategy: ${settings.account_selection_strategy}`,
      value: "set:strategy",
      category: "Core",
    },
    {
      title: `Scheduling: ${settings.scheduling_mode}`,
      value: "set:scheduling",
      category: "Core",
    },
    {
      title: `PID offset: ${settings.pid_offset_enabled ? "on" : "off"}`,
      value: "toggle:pid_offset_enabled",
      category: "Core",
    },
    {
      title: `Switch on first rate limit: ${settings.switch_on_first_rate_limit ? "on" : "off"}`,
      value: "toggle:switch_on_first_rate_limit",
      category: "Core",
    },
    {
      title: `CLI first: ${settings.cli_first ? "on" : "off"}`,
      value: "toggle:cli_first",
      category: "Core",
    },
    {
      title: `Max cache wait (s): ${settings.max_cache_first_wait_seconds}`,
      value: "set:max_cache_first_wait_seconds",
      category: "Timing",
    },
    {
      title: `Max total rate-limit wait (s): ${settings.max_rate_limit_wait_seconds}`,
      value: "set:max_rate_limit_wait_seconds",
      category: "Timing",
    },
    {
      title: `Default retry-after (s): ${settings.default_retry_after_seconds}`,
      value: "set:default_retry_after_seconds",
      category: "Timing",
    },
    {
      title: `Max backoff (s): ${settings.max_backoff_seconds}`,
      value: "set:max_backoff_seconds",
      category: "Timing",
    },
    {
      title: `Request jitter max (ms): ${settings.request_jitter_max_ms}`,
      value: "set:request_jitter_max_ms",
      category: "Timing",
    },
    {
      title: `Soft quota threshold (%): ${settings.soft_quota_threshold_percent}`,
      value: "set:soft_quota_threshold_percent",
      category: "Quota",
    },
    {
      title: `Quota refresh interval (min): ${settings.quota_refresh_interval_minutes}`,
      value: "set:quota_refresh_interval_minutes",
      category: "Quota",
    },
    {
      title: "Show effective settings",
      value: "show:effective",
      category: "Inspect",
      description: path,
    },
    {
      title: "Back",
      value: "back",
      category: "Navigation",
    },
  ];

  api.ui.dialog.setSize("xlarge");
  api.ui.dialog.replace(() =>
    createDialogSelect(api, {
      title: "Load Balancer Settings",
      options,
      onSelect: (item: TuiDialogSelectOption<string>) => {
        if (item.value === "back") {
          showAccountsDialog(api);
          return;
        }

        if (item.value === "set:strategy") {
          showStrategySelect(api, () => showLoadBalancerSettingsDialog(api));
          return;
        }
        if (item.value === "set:scheduling") {
          showSchedulingSelect(api, () => showLoadBalancerSettingsDialog(api));
          return;
        }

        if (item.value.startsWith("toggle:")) {
          const key = item.value.slice("toggle:".length) as keyof LoadBalancerSettings;
          const next = !Boolean(settings[key]);
          void writeSettingsPatch({ [key]: next } as Partial<LoadBalancerSettings>).then((result) => {
            api.ui.toast({
              variant: result.ok ? "success" : "error",
              message: result.ok ? `${key} set to ${next}.` : `Failed: ${result.message}`,
            });
            showLoadBalancerSettingsDialog(api);
          });
          return;
        }

        if (item.value.startsWith("set:")) {
          const key = item.value.slice("set:".length) as keyof LoadBalancerSettings;
          if (key === "max_rate_limit_wait_seconds") {
            showNumericPrompt(api, "Max total rate-limit wait seconds", settings.max_rate_limit_wait_seconds, 0, 3600, () => showLoadBalancerSettingsDialog(api), key);
            return;
          }
          if (key === "max_cache_first_wait_seconds") {
            showNumericPrompt(api, "Max cache wait seconds", settings.max_cache_first_wait_seconds, 5, 300, () => showLoadBalancerSettingsDialog(api), key);
            return;
          }
          if (key === "default_retry_after_seconds") {
            showNumericPrompt(api, "Default retry-after seconds", settings.default_retry_after_seconds, 1, 300, () => showLoadBalancerSettingsDialog(api), key);
            return;
          }
          if (key === "max_backoff_seconds") {
            showNumericPrompt(api, "Max backoff seconds", settings.max_backoff_seconds, 5, 300, () => showLoadBalancerSettingsDialog(api), key);
            return;
          }
          if (key === "request_jitter_max_ms") {
            showNumericPrompt(api, "Request jitter max ms", settings.request_jitter_max_ms, 0, 5000, () => showLoadBalancerSettingsDialog(api), key);
            return;
          }
          if (key === "soft_quota_threshold_percent") {
            showNumericPrompt(api, "Soft quota threshold percent", settings.soft_quota_threshold_percent, 1, 100, () => showLoadBalancerSettingsDialog(api), key);
            return;
          }
          if (key === "quota_refresh_interval_minutes") {
            showNumericPrompt(api, "Quota refresh interval minutes", settings.quota_refresh_interval_minutes, 0, 60, () => showLoadBalancerSettingsDialog(api), key);
            return;
          }
        }

        if (item.value === "show:effective") {
          showTextDialog(
            api,
            "Effective Load Balancer Settings",
            [
              `strategy=${settings.account_selection_strategy}`,
              `scheduling=${settings.scheduling_mode}`,
              `pid_offset_enabled=${settings.pid_offset_enabled}`,
              `switch_on_first_rate_limit=${settings.switch_on_first_rate_limit}`,
              `cli_first=${settings.cli_first}`,
              `max_rate_limit_wait_seconds=${settings.max_rate_limit_wait_seconds}`,
              `max_cache_first_wait_seconds=${settings.max_cache_first_wait_seconds}`,
              `default_retry_after_seconds=${settings.default_retry_after_seconds}`,
              `max_backoff_seconds=${settings.max_backoff_seconds}`,
              `request_jitter_max_ms=${settings.request_jitter_max_ms}`,
              `soft_quota_threshold_percent=${settings.soft_quota_threshold_percent}`,
              `quota_refresh_interval_minutes=${settings.quota_refresh_interval_minutes}`,
              `config=${path}`,
            ],
            () => showLoadBalancerSettingsDialog(api),
          );
          return;
        }

        if (item.value.startsWith("preset:")) {
          let patch: Partial<LoadBalancerSettings> = {};
          if (item.value === "preset:throughput") {
            patch = {
              account_selection_strategy: "round-robin",
              scheduling_mode: "performance_first",
              pid_offset_enabled: true,
            };
          }
          if (item.value === "preset:balanced") {
            patch = {
              account_selection_strategy: "hybrid",
              scheduling_mode: "balance",
              pid_offset_enabled: true,
            };
          }
          if (item.value === "preset:cache") {
            patch = {
              account_selection_strategy: "hybrid",
              scheduling_mode: "cache_first",
              pid_offset_enabled: false,
            };
          }
          if (item.value === "preset:rate-limit-hardened") {
            patch = {
              account_selection_strategy: "hybrid",
              scheduling_mode: "cache_first",
              pid_offset_enabled: false,
              switch_on_first_rate_limit: true,
              max_rate_limit_wait_seconds: 900,
              max_cache_first_wait_seconds: 60,
              default_retry_after_seconds: 30,
              max_backoff_seconds: 90,
              request_jitter_max_ms: 400,
              soft_quota_threshold_percent: 100,
              quota_refresh_interval_minutes: 2,
              cli_first: true,
            };
          }
          void writeSettingsPatch(patch).then((result) => {
            api.ui.toast({
              variant: result.ok ? "success" : "error",
              message: result.ok ? "Preset applied." : `Failed: ${result.message}`,
            });
            showLoadBalancerSettingsDialog(api);
          });
        }
      },
    }),
  );
}

function showTextDialog(api: TuiApi, title: string, lines: string[], onBack?: () => void): void {
  const options: TuiDialogSelectOption<string>[] = [
    ...lines.map((line, i) => ({
      title: line,
      value: `line:${i}`,
      category: "Info",
    })),
    {
      title: "Back",
      value: "back",
      category: "Navigation",
    },
  ];

  api.ui.dialog.setSize("xlarge");
  api.ui.dialog.replace(() =>
    createDialogSelect(api, {
      title,
      options,
      onSelect: (item: TuiDialogSelectOption<string>) => {
        if (item.value === "back") {
          if (onBack) onBack();
        }
      },
    }),
  );
}

function markVerificationRequired(account: AccountMetadataV3, reason: string, verifyUrl?: string): boolean {
  let changed = false;
  if (account.verificationRequired !== true) {
    account.verificationRequired = true;
    changed = true;
  }
  if (account.verificationRequiredAt === undefined) {
    account.verificationRequiredAt = Date.now();
    changed = true;
  }
  const normalizedReason = reason.trim();
  if (account.verificationRequiredReason !== normalizedReason) {
    account.verificationRequiredReason = normalizedReason;
    changed = true;
  }
  const normalizedUrl = verifyUrl?.trim();
  if (normalizedUrl && account.verificationUrl !== normalizedUrl) {
    account.verificationUrl = normalizedUrl;
    changed = true;
  }
  if (account.enabled !== false) {
    account.enabled = false;
    changed = true;
  }
  return changed;
}

function clearVerificationRequired(account: AccountMetadataV3): boolean {
  let changed = false;
  if (account.verificationRequired !== false) {
    account.verificationRequired = false;
    changed = true;
  }
  if (account.verificationRequiredAt !== undefined) {
    account.verificationRequiredAt = undefined;
    changed = true;
  }
  if (account.verificationRequiredReason !== undefined) {
    account.verificationRequiredReason = undefined;
    changed = true;
  }
  if (account.verificationUrl !== undefined) {
    account.verificationUrl = undefined;
    changed = true;
  }
  if (account.enabled === false) {
    account.enabled = true;
    changed = true;
  }
  return changed;
}

async function runQuotaCheck(api: TuiApi): Promise<void> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    api.ui.toast({ variant: "error", message: "No accounts found." });
    return;
  }

  api.ui.toast({ variant: "info", message: `Checking quotas for ${storage.accounts.length} account(s)...` });
  const results = await checkAccountsQuota(storage.accounts, api.client, ANTIGRAVITY_PROVIDER_ID);

  let storageUpdated = false;
  const lines: string[] = [];
  for (const result of results) {
    const label = result.email || `Account ${result.index + 1}`;
    if (result.status === "error") {
      lines.push(`${label}: ERROR - ${result.error ?? "quota fetch failed"}`);
      continue;
    }

    if (result.updatedAccount) {
      storage.accounts[result.index] = {
        ...result.updatedAccount,
        cachedQuota: result.quota?.groups,
        cachedQuotaUpdatedAt: Date.now(),
      };
      storageUpdated = true;
    } else {
      const acc = storage.accounts[result.index];
      if (acc && result.quota?.groups) {
        acc.cachedQuota = result.quota.groups;
        acc.cachedQuotaUpdatedAt = Date.now();
        storageUpdated = true;
      }
    }

    lines.push(`${label}`);
    const claude = result.quota?.groups?.claude;
    const pro = result.quota?.groups?.["gemini-pro"];
    const flash = result.quota?.groups?.["gemini-flash"];

    const formatPct = (fraction?: number) =>
      typeof fraction === "number" ? `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` : "n/a";

    lines.push(`  Antigravity Claude: ${formatPct(claude?.remainingFraction)}${formatReset(claude?.resetTime)}`);
    lines.push(`  Antigravity Gemini Pro: ${formatPct(pro?.remainingFraction)}${formatReset(pro?.resetTime)}`);
    lines.push(`  Antigravity Gemini Flash: ${formatPct(flash?.remainingFraction)}${formatReset(flash?.resetTime)}`);

    if (result.geminiCliQuota?.models?.length) {
      for (const model of result.geminiCliQuota.models) {
        lines.push(
          `  Gemini CLI ${model.modelId}: ${Math.round(model.remainingFraction * 100)}%${formatReset(model.resetTime)}`,
        );
      }
    }
  }

  if (storageUpdated) {
    await saveAccounts(storage);
  }

  showTextDialog(api, "Quota Results", lines, () => showAccountsDialog(api));
}

async function runConfigureModels(api: TuiApi): Promise<void> {
  const result = await updateOpencodeConfig();
  if (!result.success) {
    api.ui.toast({ variant: "error", message: result.error || "Failed to configure models." });
    return;
  }

  showTextDialog(
    api,
    "Models Configured",
    [
      "Antigravity model definitions were written successfully.",
      `Config: ${result.configPath}`,
    ],
    () => showAccountsDialog(api),
  );
}

async function runVerifyAll(api: TuiApi): Promise<void> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    api.ui.toast({ variant: "error", message: "No accounts found." });
    return;
  }

  const lines: string[] = [];
  let changed = false;

  for (let i = 0; i < storage.accounts.length; i++) {
    const account = storage.accounts[i];
    if (!account) continue;
    const label = account.email || `Account ${i + 1}`;

    const verification = await verifyAccountAccess(account, api.client, ANTIGRAVITY_PROVIDER_ID);
    if (verification.status === "ok") {
      if (clearVerificationRequired(account)) changed = true;
      lines.push(`${label}: OK`);
      continue;
    }

    if (verification.status === "blocked") {
      if (markVerificationRequired(account, verification.message, verification.verifyUrl)) changed = true;
      lines.push(`${label}: NEEDS VERIFICATION - ${verification.message}`);
      if (verification.verifyUrl) {
        lines.push(`  URL: ${verification.verifyUrl}`);
      }
      continue;
    }

    lines.push(`${label}: ERROR - ${verification.message}`);
  }

  if (changed) {
    await saveAccountsReplace(storage);
  }

  showTextDialog(api, "Verification Results", lines, () => showAccountsDialog(api));
}

async function runVerifyOne(api: TuiApi, index: number): Promise<void> {
  const storage = await loadAccounts();
  if (!storage || !storage.accounts[index]) {
    api.ui.toast({ variant: "error", message: "Account not found." });
    return;
  }
  const account = storage.accounts[index]!;
  const label = account.email || `Account ${index + 1}`;
  const verification = await verifyAccountAccess(account, api.client, ANTIGRAVITY_PROVIDER_ID);

  if (verification.status === "ok") {
    const changed = clearVerificationRequired(account);
    if (changed) {
      await saveAccountsReplace(storage);
    }
    showTextDialog(api, "Verification Result", [`${label}: OK`], () => showAccountActions(api, index));
    return;
  }

  if (verification.status === "blocked") {
    const changed = markVerificationRequired(account, verification.message, verification.verifyUrl);
    if (changed) {
      await saveAccountsReplace(storage);
    }
    const lines = [`${label}: NEEDS VERIFICATION`, verification.message];
    if (verification.verifyUrl) lines.push(`URL: ${verification.verifyUrl}`);
    showTextDialog(api, "Verification Result", lines, () => showAccountActions(api, index));
    return;
  }

  showTextDialog(api, "Verification Result", [`${label}: ERROR`, verification.message], () => showAccountActions(api, index));
}

function openProviderConnect(api: TuiApi, message?: string): void {
  if (message) {
    api.ui.toast({
      variant: "info",
      message,
    });
  }
  api.ui.dialog.clear();
  api.command.trigger("provider.connect");
}

function showAccountActions(api: TuiApi, index: number): void {
  const options: TuiDialogSelectOption<string>[] = [
    {
      title: "Set as current",
      value: `set-current:${index}`,
      category: "Account",
      description: "Use this account as the active account",
    },
    {
      title: "Verify this account",
      value: `verify:${index}`,
      category: "Account",
      description: "Run verification for this specific account",
    },
    {
      title: "Delete this account",
      value: `delete:${index}`,
      category: "Danger Zone",
      description: "Remove this account from local storage",
    },
    {
      title: "Back",
      value: "back",
      category: "Navigation",
    },
  ];

  api.ui.dialog.replace(() =>
    createDialogSelect(api, {
      title: `Account ${index + 1}`,
      options,
      onSelect: (item: TuiDialogSelectOption<string>) => {
        if (item.value === "back") {
          showAccountsDialog(api);
          return;
        }

        if (item.value.startsWith("set-current:")) {
          const target = Number.parseInt(item.value.split(":")[1] ?? "-1", 10);
          setCurrentIndex(target)
            .then((result) => {
              api.ui.toast({
                variant: result.ok ? "success" : "error",
                message: result.message,
              });
              showAccountsDialog(api);
            })
            .catch((error) => {
              api.ui.toast({
                variant: "error",
                message: error instanceof Error ? error.message : "Failed to update account",
              });
              showAccountsDialog(api);
            });
          return;
        }

        if (item.value.startsWith("verify:")) {
          const target = Number.parseInt(item.value.split(":")[1] ?? "-1", 10);
          void runVerifyOne(api, target);
          return;
        }

        if (item.value.startsWith("delete:")) {
          const target = Number.parseInt(item.value.split(":")[1] ?? "-1", 10);
          removeAccountByIndex(target)
            .then((result) => {
              api.ui.toast({
                variant: result.ok ? "success" : "error",
                message: result.message,
              });
              showAccountsDialog(api);
            })
            .catch((error) => {
              api.ui.toast({
                variant: "error",
                message: error instanceof Error ? error.message : "Failed to delete account",
              });
              showAccountsDialog(api);
            });
        }
      },
    }),
  );
}

function buildOptions(storage: AccountStorageV4 | null): TuiDialogSelectOption<string>[] {
  const now = Date.now();
  const list: TuiDialogSelectOption<string>[] = [
    {
      title: "Add account",
      value: "action:add",
      category: "Actions",
      description: "Run Google OAuth flow in the Antigravity account manager",
    },
    {
      title: "Check quotas",
      value: "action:quota",
      category: "Actions",
      description: "Check usage and reset windows for all stored accounts",
    },
    {
      title: "Verify all accounts",
      value: "action:verify-all",
      category: "Actions",
      description: "Run verification checks across every stored account",
    },
    {
      title: "Configure models",
      value: "action:configure-models",
      category: "Actions",
      description: "Write Antigravity model definitions to opencode.json",
    },
    {
      title: "Enable load balancer defaults",
      value: "action:enable-load-balancer",
      category: "Actions",
      description: "Set hybrid + cache_first + pid_offset_disabled in plugin config",
    },
    {
      title: "Load balancer settings",
      value: "action:load-balancer-settings",
      category: "Actions",
      description: "Granular tuning for strategy, scheduling, retries, jitter, and quota windows",
    },
    {
      title: "Reload",
      value: "action:reload",
      category: "Actions",
      description: "Refresh account list from disk",
    },
  ];

  if (!storage || storage.accounts.length === 0) {
    list.push({
      title: "No accounts found",
      value: "info:none",
      category: "Accounts",
      description: "Select Add account to create your first Antigravity account",
      disabled: true,
    });
    return list;
  }

  for (let i = 0; i < storage.accounts.length; i++) {
    const account = storage.accounts[i];
    list.push({
      title: accountLabel(i, account, storage.activeIndex, now),
      value: `account:${i}`,
      category: "Accounts",
      description: "Press Enter to open actions for this account",
    });
  }

  list.push({
    title: "Delete all accounts",
    value: "action:delete-all",
    category: "Danger Zone",
    description: "Remove all saved Antigravity accounts",
  });

  return list;
}

function handleMainAction(api: TuiApi, value: string): void {
  switch (value) {
    case "action:add":
      openProviderConnect(api, "Select Google → OAuth with Google (Antigravity), then choose Add account.");
      break;
    case "action:quota":
      void runQuotaCheck(api);
      break;
    case "action:verify-all":
      void runVerifyAll(api);
      break;
    case "action:configure-models":
      void runConfigureModels(api);
      break;
    case "action:enable-load-balancer":
      void (async () => {
        const result = await enableLoadBalancerDefaults();
        if (!result.ok) {
          api.ui.toast({ variant: "error", message: `Failed to enable load balancer defaults: ${result.message}` });
          return;
        }
        showTextDialog(
          api,
          "Load Balancer Defaults Enabled",
          [
            result.message,
            result.path ? `Config: ${result.path}` : "",
          ].filter(Boolean),
          () => showAccountsDialog(api),
        );
      })();
      break;
    case "action:load-balancer-settings":
      showLoadBalancerSettingsDialog(api);
      break;
    case "action:delete-all":
      clearAccounts()
        .then(() => {
          api.ui.toast({ variant: "success", message: "All accounts deleted." });
          showAccountsDialog(api);
        })
        .catch((error) => {
          api.ui.toast({
            variant: "error",
            message: error instanceof Error ? error.message : "Failed to delete accounts",
          });
        });
      break;
    case "action:reload":
      showAccountsDialog(api);
      break;
    default:
      break;
  }
}

function showAccountsDialog(api: TuiApi): void {
  loadAccounts()
    .then((storage) => {
      const options = buildOptions(storage);
      api.ui.dialog.setSize("large");
      api.ui.dialog.replace(() =>
        createDialogSelect(api, {
          title: "Antigravity Accounts",
          options,
          onSelect: (item: TuiDialogSelectOption<string>) => {
            if (item.value.startsWith("account:")) {
              const index = Number.parseInt(item.value.split(":")[1] ?? "-1", 10);
              if (Number.isFinite(index) && index >= 0) {
                showAccountActions(api, index);
              }
              return;
            }
            handleMainAction(api, item.value);
          },
        }),
      );
    })
    .catch((error) => {
      api.ui.toast({
        variant: "error",
        message: error instanceof Error ? error.message : "Failed to load account list",
      });
    });
}

const tui = async (api: TuiApi): Promise<void> => {
  api.command.register(() => [
    {
      title: "Antigravity Accounts",
      value: COMMAND_OPEN,
      category: "Provider",
      description: "Open interactive Antigravity account manager",
      slash: {
        name: "ag-accounts",
        aliases: ["ag"],
      },
      onSelect: () => showAccountsDialog(api),
    },
    {
      title: "Reload Antigravity Accounts",
      value: COMMAND_RELOAD,
      category: "Provider",
      hidden: true,
      onSelect: () => showAccountsDialog(api),
    },
  ]);
};

const plugin = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
