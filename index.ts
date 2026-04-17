export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin";

export {
  AntigravityBridgePlugin,
  AntigravityServerBridgePlugin,
} from "./src/bridge/proxy";

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./src/antigravity/oauth";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth";
