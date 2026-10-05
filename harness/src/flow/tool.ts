import type { JsonObject, JsonValue } from "@nylorun/core/define";
import type { FlowContext } from "./context.js";
import { FlowNodeError } from "./types.js";

type Asked = {
  readonly interaction: {
    readonly kind: "approval" | "response";
    readonly prompt: string;
    readonly metadata?: JsonObject;
  };
  readonly token?: JsonValue;
};

/**
 * A tool node's settled value, through its waits. A tool that asks (`ctx.approve`, `ctx.ask`)
 * settles `interaction-required` with a resume token: the flow pauses on it. Once the
 * checkpoint holds the answer (`FlowCheckpoint.resumes`), the tool runs again as a new effect
 * of the node (role `resume.<n>`) with the answer and the token. A rejected approval settles
 * the node `denied` without running the tool again, as in the turn loop.
 */
export async function runToolEffect(
  ctx: FlowContext,
  toolName: string,
  input: JsonValue,
  identity: { readonly path: string; readonly key: string; readonly iterations: string },
): Promise<JsonValue> {
  let context: Record<string, unknown> = { toolName };
  for (let attempt = 0; ; attempt += 1) {
    const at = attempt === 0 ? identity : { ...identity, role: `resume.${attempt}` };
    const value = (await ctx.effect("tool", input, at, context)) as JsonValue;
    const asked = askedOf(value, identity.path);
    if (!asked) return value;
    const invocationId = ctx.effectIdOf("tool", at);
    const id = `${invocationId}:interaction`;
    const answer = ctx.checkpoint.resumes?.[id];
    if (!answer)
      throw ctx.pause({
        invocationId,
        path: identity.path,
        toolName,
        interaction: { ...asked.interaction, id },
        status: "interaction",
      });
    if (answer.kind === "approval" && !answer.approved)
      return { kind: "denied", reason: "Approval rejected" };
    context = {
      toolName,
      resume: {
        interactionId: id,
        ...answer,
        ...(asked.token === undefined ? {} : { token: asked.token }),
      },
    };
  }
}

/** The interaction an `interaction-required` outcome asks for, or undefined for any other value. */
function askedOf(raw: JsonValue, path: string): Asked | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as JsonObject;
  if (value.kind !== "interaction-required") return undefined;
  const interaction = value.interaction as JsonObject | undefined;
  if (
    !interaction ||
    (interaction.kind !== "approval" && interaction.kind !== "response") ||
    typeof interaction.prompt !== "string"
  )
    throw new FlowNodeError({
      code: "tool.invalid-tool-result",
      message: "Tool returned an invalid interaction",
      path,
    });
  const metadata = interaction.metadata;
  return {
    interaction: {
      kind: interaction.kind,
      prompt: interaction.prompt,
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? { metadata: metadata as JsonObject }
        : {}),
    },
    ...(value.token === undefined ? {} : { token: value.token }),
  };
}
