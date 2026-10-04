/**
 * `@nylorun/agents/studio-embed`: the contract between Studio and an app that embeds it in an
 * iframe (Studio design §8). Studio's web app and the apps that embed it import it from here,
 * because Studio may not depend on `@nylorun/core` directly.
 *
 * No Node-only module is imported here or below.
 */
export {
  STUDIO_EMBED_MESSAGE_TYPE,
  STUDIO_EMBED_PROTOCOLS,
  StudioEmbedMessageSchema,
  StudioLoginTokenRequestSchema,
  StudioLoginTokenResponseSchema,
  StudioSessionRequestSchema,
  StudioSessionResponseSchema,
  StudioThemeSchema,
  isFrameAncestor,
  parseFrameAncestors,
} from "@nylorun/core/contracts";
export type {
  StudioEmbedKind,
  StudioEmbedMessage,
  StudioLoginTokenRequest,
  StudioLoginTokenResponse,
  StudioSessionRequest,
  StudioSessionResponse,
  StudioTheme,
} from "@nylorun/core/contracts";
