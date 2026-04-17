import { authorizeAntigravity, exchangeAntigravity } from "../antigravity/oauth";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { buildAuthSuccessFromStoredAccount, normalizeEmail, persistAccountPool } from "./account-persistence";
import { getStateFromAuthorizationUrl, extractOAuthCallbackParams, parseOAuthCallbackInput, promptAccountIndexForVerification, promptManualOAuthInput } from "./cli-auth-helpers";
import { buildExistingAccountInfos } from "./cli-account-state";
import { promptAddAnotherAccount, promptLoginMode, promptProjectId } from "./cli";
import { printQuotaCheckResults } from "./quota-report";
import { runVerifyAllAccounts, runVerifySingleAccount } from "./cli-verification";
import { clearAccounts, loadAccounts, saveAccounts, saveAccountsReplace } from "./storage";
import { checkAccountsQuota } from "./quota";
import { startOAuthListener, type OAuthListener } from "./server";
import type { AccountManager } from "./accounts";
import type { OAuthAuthorizationResult, PluginClient } from "./types";

type OpenBrowser = (url: string) => Promise<boolean>;
type LogLike = {
  error(message: string, meta?: Record<string, unknown>): void;
};

interface SharedOptions {
  client: PluginClient;
  providerId: string;
  forceGcpTos: boolean;
  openBrowser: OpenBrowser;
  log: LogLike;
}

interface CliOptions extends SharedOptions {
  accountManager: AccountManager | null;
  useManualMode: boolean;
}

async function clearStoredAuth(client: PluginClient, providerId: string, log: LogLike): Promise<void> {
  try {
    await client.auth.set({
      path: { id: providerId },
      body: { type: "oauth", refresh: "", access: "", expires: 0 },
    });
  } catch (storeError) {
    log.error("Failed to clear stored Antigravity OAuth credentials", { error: String(storeError) });
  }
}

async function setStoredAuthFromRefresh(
  client: PluginClient,
  providerId: string,
  refresh: string,
  log: LogLike,
): Promise<void> {
  try {
    await client.auth.set({
      path: { id: providerId },
      body: { type: "oauth", refresh, access: "", expires: 0 },
    });
  } catch (storeError) {
    log.error("Failed to update stored Antigravity OAuth credentials", { error: String(storeError) });
  }
}

/**
 * Handle the CLI OAuth flow used by `opencode auth login`.
 */
export async function runCliOAuthAuthorization(options: CliOptions): Promise<OAuthAuthorizationResult> {
  const accounts: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>> = [];
  let startFresh = true;
  let refreshAccountIndex: number | undefined;

  const existingStorage = await loadAccounts();
  if (existingStorage && existingStorage.accounts.length > 0) {
    while (true) {
      const existingAccounts = buildExistingAccountInfos(existingStorage);
      const menuResult = await promptLoginMode(existingAccounts);

      if (menuResult.mode === "check") {
        const results = await checkAccountsQuota(existingStorage.accounts, options.client, options.providerId);
        const storageUpdated = printQuotaCheckResults(results, existingStorage);
        if (storageUpdated) {
          await saveAccounts(existingStorage);
        }
        continue;
      }

      if (menuResult.mode === "manage") {
        if (menuResult.toggleAccountIndex !== undefined) {
          const account = existingStorage.accounts[menuResult.toggleAccountIndex];
          if (account) {
            account.enabled = account.enabled === false;
            await saveAccounts(existingStorage);
            options.accountManager?.setAccountEnabled(menuResult.toggleAccountIndex, account.enabled);
            console.log(`\nAccount ${account.email || menuResult.toggleAccountIndex + 1} ${account.enabled ? "enabled" : "disabled"}.\n`);
          }
        }
        continue;
      }

      if (menuResult.mode === "verify" || menuResult.mode === "verify-all") {
        const verifyAll = menuResult.mode === "verify-all" || menuResult.verifyAll === true;
        if (verifyAll) {
          await runVerifyAllAccounts(existingStorage, options.client, options.providerId, options.accountManager);
          continue;
        }

        let verifyAccountIndex = menuResult.verifyAccountIndex;
        if (verifyAccountIndex === undefined) {
          verifyAccountIndex = await promptAccountIndexForVerification(existingAccounts);
        }
        if (verifyAccountIndex === undefined) {
          console.log("\nVerification cancelled.\n");
          continue;
        }

        await runVerifySingleAccount(
          existingStorage,
          verifyAccountIndex,
          options.client,
          options.providerId,
          options.accountManager,
          options.openBrowser,
        );
        continue;
      }

      if (menuResult.mode === "cancel") {
        return {
          url: "",
          instructions: "Authentication cancelled",
          method: "auto",
          callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
        };
      }

      if (menuResult.deleteAccountIndex !== undefined) {
        const updatedAccounts = existingStorage.accounts.filter((_, idx) => idx !== menuResult.deleteAccountIndex);
        await saveAccountsReplace({
          version: 4,
          accounts: updatedAccounts,
          activeIndex: 0,
          activeIndexByFamily: { claude: 0, gemini: 0 },
        });
        options.accountManager?.removeAccountByIndex(menuResult.deleteAccountIndex);
        console.log("\nAccount deleted.\n");

        if (updatedAccounts.length > 0) {
          const fallbackAccount = updatedAccounts[0];
          if (fallbackAccount?.refreshToken) {
            const fallbackResult = buildAuthSuccessFromStoredAccount(fallbackAccount);
            await setStoredAuthFromRefresh(options.client, options.providerId, fallbackResult.refresh, options.log);
            const label = fallbackAccount.email || "Account 1";
            return {
              url: "",
              instructions: `Account deleted. Using ${label} for future requests.`,
              method: "auto",
              callback: async () => fallbackResult,
            };
          }
        }

        await clearStoredAuth(options.client, options.providerId, options.log);
        return {
          url: "",
          instructions: "All accounts deleted. Run `opencode auth login` to reauthenticate.",
          method: "auto",
          callback: async () => ({ type: "failed", error: "All accounts deleted. Reauthentication required." }),
        };
      }

      if (menuResult.refreshAccountIndex !== undefined) {
        refreshAccountIndex = menuResult.refreshAccountIndex;
        const refreshEmail = existingStorage.accounts[refreshAccountIndex]?.email;
        console.log(`\nRe-authenticating ${refreshEmail || "account"}...\n`);
        startFresh = false;
      }

      if (menuResult.deleteAll) {
        await clearAccounts();
        console.log("\nAll accounts deleted.\n");
        startFresh = true;
        await clearStoredAuth(options.client, options.providerId, options.log);
      } else {
        startFresh = menuResult.mode === "fresh";
      }

      console.log(startFresh && !menuResult.deleteAll
        ? "\nStarting fresh - existing accounts will be replaced.\n"
        : "\nAdding to existing accounts.\n");
      break;
    }
  }

  while (accounts.length < 10) {
    console.log(`\n=== Antigravity OAuth (Account ${accounts.length + 1}) ===`);
    const projectId = await promptProjectId();

    const result = await runOAuthAttempt({
      ...options,
      projectId,
      useManualMode: options.useManualMode,
    });

    if (result.type === "failed") {
      if (accounts.length === 0) {
        return {
          url: "",
          instructions: `Authentication failed: ${result.error}`,
          method: "auto",
          callback: async () => result,
        };
      }

      console.warn(`[opencode-antigravity-auth] Skipping failed account ${accounts.length + 1}: ${result.error}`);
      let currentAccountCount = accounts.length;
      try {
        const currentStorage = await loadAccounts();
        if (currentStorage) {
          currentAccountCount = currentStorage.accounts.length;
        }
      } catch {
      }
      const retryAddAnother = await promptAddAnotherAccount(currentAccountCount);
      if (retryAddAnother) {
        continue;
      }
      break;
    }

    accounts.push(result);
    try {
      const toastEmail = normalizeEmail(result.email);
      await options.client.tui.showToast({
        body: {
          message: `Account ${accounts.length} authenticated${toastEmail ? ` (${toastEmail})` : ""}`,
          variant: "success",
        },
      });
    } catch {
    }

    if (refreshAccountIndex !== undefined) {
      const currentStorage = await loadAccounts();
      if (currentStorage) {
        const updatedAccounts = [...currentStorage.accounts];
        const parts = result.type === "success" ? result : null;
        const parsed = parts ? parts.refresh : "";
        const refreshParts = parsed ? await import("./auth").then((m) => m.parseRefreshParts(parsed)) : null;
        if (refreshParts?.refreshToken) {
          updatedAccounts[refreshAccountIndex] = {
            email: normalizeEmail(result.email) ?? updatedAccounts[refreshAccountIndex]?.email,
            refreshToken: refreshParts.refreshToken,
            projectId: refreshParts.projectId ?? updatedAccounts[refreshAccountIndex]?.projectId,
            managedProjectId: refreshParts.managedProjectId ?? updatedAccounts[refreshAccountIndex]?.managedProjectId,
            isGcpTos: refreshParts.isGcpTos ?? updatedAccounts[refreshAccountIndex]?.isGcpTos,
            addedAt: updatedAccounts[refreshAccountIndex]?.addedAt ?? Date.now(),
            lastUsed: Date.now(),
          };
          await saveAccounts({
            version: 4,
            accounts: updatedAccounts,
            activeIndex: currentStorage.activeIndex,
            activeIndexByFamily: currentStorage.activeIndexByFamily,
          });
        }
      }
      break;
    }

    const isFirstAccount = accounts.length === 1;
    await persistAccountPool([result], isFirstAccount && startFresh);

    if (accounts.length >= 10) {
      break;
    }

    let currentAccountCount = accounts.length;
    try {
      const currentStorage = await loadAccounts();
      if (currentStorage) {
        currentAccountCount = currentStorage.accounts.length;
      }
    } catch {
    }

    const addAnother = await promptAddAnotherAccount(currentAccountCount);
    if (!addAnother) {
      break;
    }
  }

  const primary = accounts[0];
  if (!primary) {
    return {
      url: "",
      instructions: "Authentication cancelled",
      method: "auto",
      callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
    };
  }

  let actualAccountCount = accounts.length;
  try {
    const finalStorage = await loadAccounts();
    if (finalStorage) {
      actualAccountCount = finalStorage.accounts.length;
    }
  } catch {
  }

  return {
    url: "",
    instructions: refreshAccountIndex !== undefined
      ? "Token refreshed successfully."
      : `Multi-account setup complete (${actualAccountCount} account(s)).`,
    method: "auto",
    callback: async () => primary,
  };
}

interface OAuthAttemptOptions extends SharedOptions {
  projectId: string;
  useManualMode: boolean;
}

async function runOAuthAttempt(options: OAuthAttemptOptions): Promise<AntigravityTokenExchangeResult> {
  let listener: OAuthListener | null = null;
  if (!options.useManualMode) {
    try {
      listener = await startOAuthListener();
    } catch {
      listener = null;
    }
  }

  const authorization = await authorizeAntigravity(options.projectId, {
    redirectUri: listener?.redirectUri(),
    isGcpTos: options.forceGcpTos,
  });
  const fallbackState = getStateFromAuthorizationUrl(authorization.url);

  console.log("\nOAuth URL:\n" + authorization.url + "\n");

  if (options.useManualMode) {
    const browserOpened = await options.openBrowser(authorization.url);
    if (!browserOpened) {
      console.log("Could not open browser automatically.");
      console.log("Please open the URL above manually in your local browser.\n");
    }
    return promptManualOAuthInput(fallbackState, authorization.redirectUri, options.forceGcpTos);
  }

  const browserOpened = await options.openBrowser(authorization.url);
  if (!browserOpened) {
    console.log("\nCould not open browser automatically.");
    console.log("Open this URL on any device:\n");
    console.log(authorization.url + "\n");
  }

  if (!listener) {
    return {
      type: "failed",
      error: "Could not start local OAuth callback listener. Check port availability/networking and retry.",
    };
  }

  try {
    const callbackPromise = listener.waitForCallback();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("CALLBACK_TIMEOUT")), 180000),
    );
    const callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
    const params = extractOAuthCallbackParams(callbackUrl);
    if (!params) {
      return { type: "failed", error: "Missing code or state in callback URL" };
    }
    return exchangeAntigravity(params.code, params.state, {
      redirectUri: authorization.redirectUri,
      isGcpTos: options.forceGcpTos,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "CALLBACK_TIMEOUT") {
      return {
        type: "failed",
        error: `Automatic callback was not received within 180 seconds. Ensure your browser can reach ${authorization.redirectUri} and then retry.`,
      };
    }
    return {
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    try {
      await listener.close();
    } catch {
    }
  }
}

/**
 * Handle the lightweight TUI `/connect` OAuth flow.
 */
export async function runQuickOAuthAuthorization(options: SharedOptions): Promise<OAuthAuthorizationResult> {
  const projectId = "";
  const existingStorage = await loadAccounts();
  const existingCount = existingStorage?.accounts.length ?? 0;

  let listener: OAuthListener | null = null;
  try {
    listener = await startOAuthListener();
  } catch {
    listener = null;
  }

  const authorization = await authorizeAntigravity(projectId, {
    redirectUri: listener?.redirectUri(),
    isGcpTos: options.forceGcpTos,
  });
  const fallbackState = getStateFromAuthorizationUrl(authorization.url);

  const browserOpened = await options.openBrowser(authorization.url);
  if (!browserOpened) {
    listener?.close().catch(() => {});
    listener = null;
  }

  if (listener) {
    return {
      url: authorization.url,
      instructions: "Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
      method: "auto",
      callback: async () => {
        try {
          const callbackPromise = listener.waitForCallback();
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("CALLBACK_TIMEOUT")), 30000),
          );
          const callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
          const params = extractOAuthCallbackParams(callbackUrl);
          if (!params) {
            return { type: "failed", error: "Missing code or state in callback URL" } as AntigravityTokenExchangeResult;
          }

          const result = await exchangeAntigravity(params.code, params.state, {
            redirectUri: authorization.redirectUri,
            isGcpTos: options.forceGcpTos,
          });
          if (result.type === "success") {
            await persistAccountPool([result], false).catch(() => {});
            const newTotal = existingCount + 1;
            const toastEmail = normalizeEmail(result.email);
            const toastMessage = existingCount > 0
              ? `Added account${toastEmail ? ` (${toastEmail})` : ""} - ${newTotal} total`
              : `Authenticated${toastEmail ? ` (${toastEmail})` : ""}`;
            await options.client.tui.showToast({
              body: { message: toastMessage, variant: "success" },
            }).catch(() => {});
          }
          return result;
        } catch (error) {
          return {
            type: "failed",
            error: error instanceof Error ? error.message : "Unknown error",
          } as AntigravityTokenExchangeResult;
        } finally {
          try {
            await listener.close();
          } catch {
          }
        }
      },
    };
  }

  return {
    url: authorization.url,
    instructions: "Visit the URL above, complete OAuth, then paste either the full redirect URL or the authorization code.",
    method: "code",
    callback: async (codeInput: string) => {
      const params = parseOAuthCallbackInput(codeInput, fallbackState);
      if ("error" in params) {
        return { type: "failed", error: params.error };
      }
      const result = await exchangeAntigravity(params.code, params.state, {
        redirectUri: authorization.redirectUri,
        isGcpTos: options.forceGcpTos,
      });
      if (result.type === "success") {
        await persistAccountPool([result], false).catch(() => {});
        const newTotal = existingCount + 1;
        const toastEmail = normalizeEmail(result.email);
        const toastMessage = existingCount > 0
          ? `Added account${toastEmail ? ` (${toastEmail})` : ""} - ${newTotal} total`
          : `Authenticated${toastEmail ? ` (${toastEmail})` : ""}`;
        await options.client.tui.showToast({
          body: { message: toastMessage, variant: "success" },
        }).catch(() => {});
      }
      return result;
    },
  };
}
