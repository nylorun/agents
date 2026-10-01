/**
 * The message bridge between an embedded Studio and its embedder (Studio §8.8).
 *
 * - Before `init`, Studio cannot know its parent's origin (no Referer, and Firefox
 *   has no `ancestorOrigins`), so `ready` goes to each allowlisted origin with that
 *   exact `targetOrigin`; the browser delivers it only to the real parent.
 * - A message is accepted only from `window.parent`, from an allowlisted origin,
 *   and when the shared schema parses it. The first valid `init` pins the origin;
 *   afterwards every other origin is ignored and every reply goes to it, never `*`.
 *
 * Pure apart from the window it is given, so it is tested with a fake one.
 */
import {
  STUDIO_EMBED_MESSAGE_TYPE,
  STUDIO_EMBED_PROTOCOLS,
  StudioEmbedMessageSchema,
  type StudioEmbedMessage,
} from "@nylorun/agents/studio-embed";

/** Messages the embedder sends to Studio. */
export type InboundMessage = Extract<
  StudioEmbedMessage,
  { kind: "init" | "token.refresh" | "theme.changed" | "navigate" }
>;
/** Messages Studio sends to the embedder, without the envelope. */
export type OutboundMessage = DistributiveOmit<
  Exclude<StudioEmbedMessage, InboundMessage>,
  "type" | "protocol"
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type MessageTarget = { postMessage(message: unknown, targetOrigin: string): void };

export type BridgeWindow = {
  parent: MessageTarget;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export type Bridge = Readonly<{
  /** The embedder's origin once `init` arrived. */
  origin(): string | undefined;
  /** Sends to the pinned origin; dropped before `init`. */
  post(message: OutboundMessage): void;
  stop(): void;
}>;

const INBOUND = new Set(["init", "token.refresh", "theme.changed", "navigate"]);

export function startBridge(options: {
  window: BridgeWindow;
  allowed: readonly string[];
  studioVersion: string;
  onMessage: (message: InboundMessage) => void;
}): Bridge {
  const { window: win, allowed } = options;
  const allowedSet = new Set(allowed);
  let pinned: string | undefined;
  let protocol: number | undefined;

  const envelope = (message: OutboundMessage, version: number) => ({
    type: STUDIO_EMBED_MESSAGE_TYPE,
    protocol: version,
    ...message,
  });

  const post = (message: OutboundMessage) => {
    if (pinned === undefined || protocol === undefined) return;
    win.parent.postMessage(envelope(message, protocol), pinned);
  };

  const listener = (event: MessageEvent) => {
    if (event.source !== win.parent) return;
    if (!allowedSet.has(event.origin)) return;
    if (pinned !== undefined && event.origin !== pinned) return;
    const parsed = StudioEmbedMessageSchema.safeParse(event.data);
    if (!parsed.success || !INBOUND.has(parsed.data.kind)) return;
    const message = parsed.data as InboundMessage;
    if (pinned === undefined) {
      // Only `init` opens the conversation and pins the embedder's origin.
      if (message.kind !== "init") return;
      if (!(STUDIO_EMBED_PROTOCOLS as readonly number[]).includes(message.protocol)) {
        win.parent.postMessage(
          envelope(
            {
              kind: "error",
              code: "protocol_unsupported",
              message: `Studio speaks protocol ${STUDIO_EMBED_PROTOCOLS.join(", ")}.`,
            },
            STUDIO_EMBED_PROTOCOLS[0],
          ),
          event.origin,
        );
        return;
      }
      pinned = event.origin;
      protocol = message.protocol;
    }
    options.onMessage(message);
  };

  win.addEventListener("message", listener);
  const ready = envelope(
    {
      kind: "ready",
      protocols: [...STUDIO_EMBED_PROTOCOLS],
      studioVersion: options.studioVersion,
    },
    STUDIO_EMBED_PROTOCOLS[0],
  );
  for (const origin of allowed) win.parent.postMessage(ready, origin);

  return Object.freeze({
    origin: () => pinned,
    post,
    stop: () => win.removeEventListener("message", listener),
  });
}

/** The allowlist the server put in `index.html` (`<meta name="nylorun-frame-ancestors">`). */
export function frameAncestorsFrom(document: Pick<Document, "querySelector">): string[] {
  const content =
    document
      .querySelector('meta[name="nylorun-frame-ancestors"]')
      ?.getAttribute("content") ?? "";
  return content.split(/\s+/).filter((origin) => origin !== "");
}
