import {
  Agent as CoreAgent,
  AgentBuilder as CoreAgentBuilder,
} from "@nylorun/core/define";
import type {
  AgentOptions,
  CapabilityInput,
  ToolSchemaSource,
} from "@nylorun/core/define";
import { skills, type SkillsOptions } from "./skills/index.js";
import { plugin } from "./plugins/plugin.js";

/**
 * The agent builder with the capabilities that read files: `.skills()` and `.plugin()`.
 * `@nylorun/agents/define` exports the portable builder from core, without them.
 */
export class AgentBuilder<
  Info = unknown,
  Schema extends ToolSchemaSource | undefined = undefined,
  Id extends string = string,
> extends CoreAgentBuilder<Info, Schema, Id> {
  /** Load an Agent Skills folder. */
  skills(directory: string, options?: SkillsOptions): this {
    return this.capability(skills(directory, options) as CapabilityInput<Info>);
  }

  /** Attach an Agent Plugin package. */
  plugin(directory: string): this {
    return this.capability(plugin(directory) as CapabilityInput<Info>);
  }

  override output<S extends ToolSchemaSource>(schema: S): AgentBuilder<Info, S, Id> {
    return super.output(schema) as unknown as AgentBuilder<Info, S, Id>;
  }
}

export function Agent<
  Info = unknown,
  Schema extends ToolSchemaSource | undefined = undefined,
  const Id extends string = string,
>(options: AgentOptions<Schema> & { readonly id: Id }): AgentBuilder<Info, Schema, Id> {
  return new AgentBuilder<Info, Schema, Id>(options);
}

export namespace Agent {
  export const from = CoreAgent.from;
}
