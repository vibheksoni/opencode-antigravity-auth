import { clearStoredAccountVerificationRequired, markStoredAccountVerificationRequired, promptOpenVerificationUrl } from "./cli-auth-helpers";
import { saveAccounts, type AccountStorageV4 } from "./storage";
import type { AccountManager } from "./accounts";
import type { PluginClient } from "./types";
import { verifyAccountAccess } from "./verification";

/**
 * Run verification across every stored account and persist updated state.
 *
 * @param storage AccountStorageV4 - Current stored accounts.
 * @param client PluginClient - Plugin client for auth refresh.
 * @param providerId string - Provider identifier.
 * @param accountManager AccountManager | null - Active account manager.
 * @returns Promise<void> - Resolves after verification and persistence.
 */
export async function runVerifyAllAccounts(
  storage: AccountStorageV4,
  client: PluginClient,
  providerId: string,
  accountManager: AccountManager | null,
): Promise<void> {
  if (storage.accounts.length === 0) {
    console.log("\nNo accounts available to verify.\n");
    return;
  }

  console.log(`\nChecking verification status for ${storage.accounts.length} account(s)...\n`);

  let okCount = 0;
  let blockedCount = 0;
  let errorCount = 0;
  let storageUpdated = false;
  const blockedResults: Array<{ label: string; message: string; verifyUrl?: string }> = [];

  for (let i = 0; i < storage.accounts.length; i += 1) {
    const account = storage.accounts[i];
    if (!account) continue;

    const label = account.email || `Account ${i + 1}`;
    process.stdout.write(`- [${i + 1}/${storage.accounts.length}] ${label} ... `);

    const verification = await verifyAccountAccess(account, client, providerId);
    if (verification.status === "ok") {
      const { changed, wasVerificationRequired } = clearStoredAccountVerificationRequired(account, true);
      if (changed) {
        storageUpdated = true;
      }
      accountManager?.clearAccountVerificationRequired(i, wasVerificationRequired);
      okCount += 1;
      console.log("ok");
      continue;
    }

    if (verification.status === "blocked") {
      const changed = markStoredAccountVerificationRequired(account, verification.message, verification.verifyUrl);
      if (changed) {
        storageUpdated = true;
      }
      accountManager?.markAccountVerificationRequired(i, verification.message, verification.verifyUrl);

      blockedCount += 1;
      console.log("needs verification");
      blockedResults.push({
        label,
        message: verification.message,
        verifyUrl: verification.verifyUrl ?? account.verificationUrl,
      });
      continue;
    }

    errorCount += 1;
    console.log(`error (${verification.message})`);
  }

  if (storageUpdated) {
    await saveAccounts(storage);
  }

  console.log(`\nVerification summary: ${okCount} ready, ${blockedCount} need verification, ${errorCount} errors.`);

  if (blockedResults.length > 0) {
    console.log("\nAccounts needing verification:");
    for (const result of blockedResults) {
      console.log(`\n- ${result.label}`);
      console.log(`  ${result.message}`);
      console.log(`  URL: ${result.verifyUrl || "not provided by API response"}`);
    }
    console.log("");
  } else {
    console.log("");
  }
}

/**
 * Run verification for one stored account and persist updated state.
 *
 * @param storage AccountStorageV4 - Current stored accounts.
 * @param verifyAccountIndex number - Selected account index.
 * @param client PluginClient - Plugin client for auth refresh.
 * @param providerId string - Provider identifier.
 * @param accountManager AccountManager | null - Active account manager.
 * @param openBrowser (url: string) => Promise<boolean> - Browser opener.
 * @returns Promise<void> - Resolves after verification and persistence.
 */
export async function runVerifySingleAccount(
  storage: AccountStorageV4,
  verifyAccountIndex: number,
  client: PluginClient,
  providerId: string,
  accountManager: AccountManager | null,
  openBrowser: (url: string) => Promise<boolean>,
): Promise<void> {
  const account = storage.accounts[verifyAccountIndex];
  if (!account) {
    console.log(`\nAccount ${verifyAccountIndex + 1} not found.\n`);
    return;
  }

  const label = account.email || `Account ${verifyAccountIndex + 1}`;
  console.log(`\nChecking verification status for ${label}...\n`);

  const verification = await verifyAccountAccess(account, client, providerId);

  if (verification.status === "ok") {
    const { changed, wasVerificationRequired } = clearStoredAccountVerificationRequired(account, true);
    if (changed) {
      await saveAccounts(storage);
    }
    accountManager?.clearAccountVerificationRequired(verifyAccountIndex, wasVerificationRequired);

    if (wasVerificationRequired) {
      console.log(`${label} is ready for requests and has been re-enabled.\n`);
    } else {
      console.log(`${label} is ready for requests.\n`);
    }
    return;
  }

  if (verification.status === "blocked") {
    const changed = markStoredAccountVerificationRequired(account, verification.message, verification.verifyUrl);
    if (changed) {
      await saveAccounts(storage);
    }
    accountManager?.markAccountVerificationRequired(
      verifyAccountIndex,
      verification.message,
      verification.verifyUrl,
    );

    const verifyUrl = verification.verifyUrl ?? account.verificationUrl;
    console.log(`${label} needs Google verification before it can be used.`);
    if (verification.message) {
      console.log(verification.message);
    }
    console.log(`${label} has been disabled until verification is completed.`);

    if (verifyUrl) {
      console.log(`\nVerification URL:\n${verifyUrl}\n`);
      if (await promptOpenVerificationUrl()) {
        const opened = await openBrowser(verifyUrl);
        if (opened) {
          console.log("Opened verification URL in your browser.\n");
        } else {
          console.log("Could not open browser automatically. Please open the URL manually.\n");
        }
      }
    } else {
      console.log("No verification URL was returned. Try re-authenticating this account.\n");
    }
    return;
  }

  console.log(`${label}: ${verification.message}\n`);
}
