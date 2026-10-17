/**
 * `nylorun tenant signing-keys`: the Tenant's signing keys, which sign capability links and run
 * tokens, through the Management API. (Subject tokens, the access policy, browser keys and
 * revocations left the Runtime in protocol 7.)
 */
import { CliError, HelpRequest, isHelp } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { connect, managementClient } from "./target.js";

export const signingKeysUsage = `  signing-keys list [--tenant <name>]
                                      the Tenant's token signing keys
  signing-keys rotate [--force] [--tenant <name>]
                                      rotate; --force ends outstanding links and run tokens
  signing-keys revoke <kid> [--tenant <name>]
                                      revoke a previous or standby key`;

const usageError = (message = `Usage:\n${signingKeysUsage}`) => new CliError(message, 2);

export async function signingKeysCommand(
  deps: StackDeps,
  input: readonly string[],
): Promise<number> {
  const [action, ...args] = input;
  if (isHelp(action)) throw new HelpRequest(`Usage:\n${signingKeysUsage}`);
  const flags = parseStackFlags(
    args,
    { booleans: action === "rotate" ? ["--force"] : [], values: ["--tenant"] },
    signingKeysUsage,
  );
  const arity = action === "revoke" ? 1 : 0;
  if (!["list", "rotate", "revoke"].includes(action ?? "") || flags.rest.length !== arity)
    throw usageError();
  const keys = managementClient(deps, await connect(deps, "management", flags.values.get("--tenant")))
    .signingKeys;
  const print = (value: unknown) => deps.out(JSON.stringify(value, null, 2));
  if (action === "list") print(await keys.list());
  else if (action === "rotate") print(await keys.rotate({ force: flags.booleans.has("--force") }));
  else print(await keys.revoke(flags.rest[0]!));
  return 0;
}
