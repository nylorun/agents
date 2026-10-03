import type { BuiltAgent } from "@nylorun/agents/define";
import type { ArtifactsClient } from "@nylorun/agents";
import type { ImageEditor } from "../interior-design/image-editor.js";

export type ExampleAgent = BuiltAgent & { close?: () => Promise<void> };

export type AgentDependencies = Readonly<{
  provider: string;
  model: string;
  dataRoot: string;
  /** The Runtime's file artifacts: uploaded room photos in, redesigned images out. */
  artifacts: ArtifactsClient;
  imageEditor?: ImageEditor;
}>;

export const exampleInstructions =
  "Use tools when they are the most reliable way to answer. Be concise and report tool results.";

export const modelSelection = (provider: string, model: string) =>
  ({
    id: "model",
    ...(provider === "configured" ? {} : { model: { id: `${provider}/${model}`, controls: { temperature: 0.1 } } }),
  }) as const;
