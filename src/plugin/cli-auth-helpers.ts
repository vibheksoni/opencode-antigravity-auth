import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { exchangeAntigravity } from "../antigravity/oauth";

export type VerificationStoredAccount = {
  enabled?: boolean;
  verificationRequired?: boolean;
  verificationRequiredAt?: number;
  verificationRequiredReason?: string;
  verificationUrl?: string;
};

export type OAuthCallbackParams = {
  code: string;
  state: string;
};

/**
 * Prompt for generic OAuth/manual callback input.
 *
 * @param message string - Prompt shown to the user.
 * @returns Promise<string> - Trimmed input text.
 */
export async function promptOAuthCallbackValue(message: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Extract the state parameter from an OAuth authorization URL.
 *
 * @param authorizationUrl string - Authorization URL.
 * @returns string - Parsed state or empty string.
 */
export function getStateFromAuthorizationUrl(authorizationUrl: string): string {
  try {
    return new URL(authorizationUrl).searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}

/**
 * Extract callback params from a redirect URL.
 *
 * @param url URL - Callback URL.
 * @returns OAuthCallbackParams | null - Parsed params when present.
 */
export function extractOAuthCallbackParams(url: URL): OAuthCallbackParams | null {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return null;
  }
  return { code, state };
}

/**
 * Parse either a full callback URL or a raw authorization code.
 *
 * @param value string - User input.
 * @param fallbackState string - Original auth URL state.
 * @returns OAuthCallbackParams | { error: string } - Parsed params or error.
 */
export function parseOAuthCallbackInput(
  value: string,
  fallbackState: string,
): OAuthCallbackParams | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { error: "Missing authorization code" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? fallbackState;

    if (!code) {
      return { error: "Missing code in callback URL" };
    }
    if (!state) {
      return { error: "Missing state in callback URL" };
    }

    return { code, state };
  } catch {
    if (!fallbackState) {
      return { error: "Missing state. Paste the full redirect URL instead of only the code." };
    }

    return { code: trimmed, state: fallbackState };
  }
}

/**
 * Prompt for manual OAuth completion and exchange the resulting code.
 *
 * @param fallbackState string - Original auth URL state.
 * @param redirectUri string | undefined - Redirect URI used for the listener.
 * @param isGcpTos boolean | undefined - Whether to use the GCP ToS OAuth client pair.
 * @returns Promise<AntigravityTokenExchangeResult> - Exchange result.
 */
export async function promptManualOAuthInput(
  fallbackState: string,
  redirectUri?: string,
  isGcpTos?: boolean,
): Promise<AntigravityTokenExchangeResult> {
  console.log("1. Open the URL above in your browser and complete Google sign-in.");
  console.log("2. After approving, copy the full redirected localhost URL from the address bar.");
  console.log("3. Paste it back here.\n");

  const callbackInput = await promptOAuthCallbackValue("Paste the redirect URL (or just the code) here: ");
  const params = parseOAuthCallbackInput(callbackInput, fallbackState);
  if ("error" in params) {
    return { type: "failed", error: params.error };
  }

  return exchangeAntigravity(params.code, params.state, { redirectUri, isGcpTos });
}

/**
 * Prompt the user to choose an account for verification.
 *
 * @param accounts Array<{ email?: string; index: number }> - Available accounts.
 * @returns Promise<number | undefined> - Selected account index or undefined.
 */
export async function promptAccountIndexForVerification(
  accounts: Array<{ email?: string; index: number }>,
): Promise<number | undefined> {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log("\nSelect an account to verify:");
    for (const account of accounts) {
      const label = account.email || `Account ${account.index + 1}`;
      console.log(`  ${account.index + 1}. ${label}`);
    }
    console.log("");

    while (true) {
      const answer = (await rl.question("Account number (leave blank to cancel): ")).trim();
      if (!answer) {
        return undefined;
      }
      const parsedIndex = Number(answer);
      if (!Number.isInteger(parsedIndex)) {
        console.log("Please enter a valid account number.");
        continue;
      }
      const normalizedIndex = parsedIndex - 1;
      const selected = accounts.find((account) => account.index === normalizedIndex);
      if (!selected) {
        console.log("Please enter a number from the list above.");
        continue;
      }
      return selected.index;
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt whether the verification URL should be opened immediately.
 *
 * @returns Promise<boolean> - True when the user accepts.
 */
export async function promptOpenVerificationUrl(): Promise<boolean> {
  const answer = (await promptOAuthCallbackValue("Open verification URL in your browser now? [Y/n]: "))
    .trim()
    .toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/**
 * Mark a stored account as verification-required.
 *
 * @param account VerificationStoredAccount - Stored account object.
 * @param reason string - Reason text.
 * @param verifyUrl string | undefined - Optional verification URL.
 * @returns boolean - Whether the account was changed.
 */
export function markStoredAccountVerificationRequired(
  account: VerificationStoredAccount,
  reason: string,
  verifyUrl?: string,
): boolean {
  let changed = false;
  const wasVerificationRequired = account.verificationRequired === true;

  if (!wasVerificationRequired) {
    account.verificationRequired = true;
    changed = true;
  }

  if (!wasVerificationRequired || account.verificationRequiredAt === undefined) {
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

/**
 * Clear verification-required state on a stored account.
 *
 * @param account VerificationStoredAccount - Stored account object.
 * @param enableIfRequired boolean - Whether to re-enable the account when appropriate.
 * @returns { changed: boolean; wasVerificationRequired: boolean } - Result details.
 */
export function clearStoredAccountVerificationRequired(
  account: VerificationStoredAccount,
  enableIfRequired = false,
): { changed: boolean; wasVerificationRequired: boolean } {
  const wasVerificationRequired = account.verificationRequired === true;
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

  if (enableIfRequired && wasVerificationRequired && account.enabled === false) {
    account.enabled = true;
    changed = true;
  }

  return { changed, wasVerificationRequired };
}
