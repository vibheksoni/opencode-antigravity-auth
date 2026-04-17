import { exec } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { authorizeAntigravity, exchangeAntigravity } from "../antigravity/oauth";
import { clearAccounts, loadAccounts } from "../plugin/storage";
import { persistAccountPool } from "../plugin/account-persistence";
import { startOAuthListener } from "../plugin/server";
import { clearGoogleOAuthAuthIfOauth, getAuthStorePath, writeGoogleOAuthAuth } from "./auth-store";

type Command = "add" | "list" | "clear" | "help";

interface ParsedArgs {
  command: Command;
  noBrowser: boolean;
  isGcpTos: boolean;
}

/**
 * Parse command line arguments for the standalone account tool.
 *
 * @param argv string[] - Raw CLI arguments after the executable name.
 * @returns ParsedArgs - Normalized command flags.
 */
function parseArgs(argv: string[]): ParsedArgs {
  let command: Command = "add";
  let noBrowser = false;
  let isGcpTos = false;

  for (const arg of argv) {
    if (arg === "--no-browser") {
      noBrowser = true;
      continue;
    }
    if (arg === "--gcp-tos") {
      isGcpTos = true;
      continue;
    }
    if (arg === "add" || arg === "list" || arg === "clear" || arg === "help" || arg === "--help" || arg === "-h") {
      command = arg === "--help" || arg === "-h" ? "help" : arg;
    }
  }

  return { command, noBrowser, isGcpTos };
}

/**
 * Open the system browser for OAuth.
 *
 * @param url string - URL to open.
 * @returns boolean - True when the open command was launched.
 */
function openBrowser(url: string): boolean {
  try {
    if (process.platform === "win32") {
      exec(`start "" "${url}"`);
      return true;
    }
    if (process.platform === "darwin") {
      exec(`open "${url}"`);
      return true;
    }
    exec(`xdg-open "${url}"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt for manual OAuth callback input.
 *
 * @param prompt string - Prompt message shown to the user.
 * @returns Promise<string> - Trimmed user input.
 */
async function promptValue(prompt: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(prompt);
    return value.trim();
  } finally {
    rl.close();
  }
}

/**
 * Extract code/state from either a callback URL or a raw code string.
 *
 * @param value string - Callback URL or raw authorization code.
 * @param fallbackState string - State from the original authorization URL.
 * @returns { code: string; state: string } - Parsed OAuth callback parameters.
 */
function parseCallbackInput(value: string, fallbackState: string): { code: string; state: string } {
  try {
    const parsed = new URL(value.trim());
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state") || fallbackState;
    if (!code) {
      throw new Error("Missing code in callback URL.");
    }
    return { code, state };
  } catch {
    if (!value.trim()) {
      throw new Error("Missing authorization code.");
    }
    return { code: value.trim(), state: fallbackState };
  }
}

/**
 * Print usage information for the account tool.
 *
 * @param none void - No input.
 * @returns void - Prints help to stdout.
 */
function printHelp(): void {
  console.log("Antigravity account helper");
  console.log("");
  console.log("Usage:");
  console.log("  antigravity-account.bat add [--no-browser]");
  console.log("  antigravity-account.bat add --gcp-tos [--no-browser]");
  console.log("  antigravity-account.bat list");
  console.log("  antigravity-account.bat clear");
  console.log("");
  console.log("Default command: add");
}

/**
 * Print the current Antigravity account list.
 *
 * @param none void - No input.
 * @returns Promise<void> - Resolves after printing account details.
 */
async function listAccounts(): Promise<void> {
  const storage = await loadAccounts();
  const accounts = storage?.accounts ?? [];

  if (accounts.length === 0) {
    console.log("No Antigravity accounts saved.");
    return;
  }

  console.log(`Saved Antigravity accounts: ${accounts.length}`);
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    if (!account) {
      continue;
    }
    const label = account.email || `Account ${i + 1}`;
    const tags: string[] = [];
    if (i === (storage?.activeIndex ?? 0)) {
      tags.push("current");
    }
    if (account.enabled === false) {
      tags.push("disabled");
    }
    if (account.managedProjectId) {
      tags.push(account.managedProjectId);
    }
    if (account.isGcpTos) {
      tags.push("gcp-tos");
    }
    const suffix = tags.length > 0 ? ` [${tags.join("] [")}]` : "";
    console.log(`${i + 1}. ${label}${suffix}`);
  }
}

/**
 * Clear saved Antigravity accounts and remove OAuth auth when applicable.
 *
 * @param none void - No input.
 * @returns Promise<void> - Resolves after state is cleared.
 */
async function clearAccountState(): Promise<void> {
  await clearAccounts();
  const removedAuth = await clearGoogleOAuthAuthIfOauth();
  console.log("Cleared saved Antigravity accounts.");
  if (removedAuth) {
    console.log(`Removed OAuth session from ${getAuthStorePath()}.`);
  }
}

/**
 * Run the OAuth add-account flow and persist the resulting account.
 *
 * @param noBrowser boolean - Skip automatic browser launch.
 * @returns Promise<void> - Resolves after the account is saved.
 */
async function addAccount(noBrowser: boolean, isGcpTos: boolean): Promise<void> {
  let callbackInput = "";
  let listener = null;

  if (!noBrowser) {
    try {
      listener = await startOAuthListener();
    } catch {
      listener = null;
    }
  }

  const authorization = await authorizeAntigravity("", {
    redirectUri: listener?.redirectUri(),
    isGcpTos,
  });
  const fallbackState = new URL(authorization.url).searchParams.get("state") || "";

  if (!noBrowser && openBrowser(authorization.url)) {
    console.log("Complete Google sign-in in your browser.");
  } else {
    console.log("Open this URL in your browser:");
    console.log(authorization.url);
  }

  if (listener) {
    try {
      const callbackUrl = await listener.waitForCallback();
      callbackInput = callbackUrl.toString();
    } finally {
      await listener.close().catch(() => {});
    }
  } else {
    console.log("");
    console.log("Paste the full redirect URL or just the authorization code.");
    callbackInput = await promptValue("OAuth callback: ");
  }

  const params = parseCallbackInput(callbackInput, fallbackState);
  const result = await exchangeAntigravity(params.code, params.state, {
    redirectUri: authorization.redirectUri,
    isGcpTos,
  });
  if (result.type !== "success") {
    throw new Error(result.error);
  }

  await persistAccountPool([result], false);
  const authPath = await writeGoogleOAuthAuth({
    type: "oauth",
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
  });

  const storage = await loadAccounts();
  const accountCount = storage?.accounts.length ?? 0;
  console.log(`Added Antigravity account${result.email ? ` (${result.email})` : ""}.`);
  console.log(`Saved ${accountCount} account(s) in ${storage ? "the account pool" : "storage"}.`);
  console.log(`Updated OpenCode auth at ${authPath}.`);
}

/**
 * Main entrypoint for the standalone account tool.
 *
 * @param argv string[] - CLI arguments, excluding node and script path.
 * @returns Promise<void> - Resolves when the command finishes.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "help":
      printHelp();
      return;
    case "list":
      await listAccounts();
      return;
    case "clear":
      await clearAccountState();
      return;
    case "add":
    default:
      await addAccount(args.noBrowser, args.isGcpTos);
      return;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
