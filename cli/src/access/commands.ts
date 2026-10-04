/**
 * `nylo access`: the linked Tenant's signing keys, which sign delivery tokens and capability
 * links. Uses the Project's application key, like every other Tenant command. (Subject tokens,
 * the access policy, browser keys and revocations left the Runtime in protocol 7.)
 */
import {
  createClient,
  resolveConnection,
  type AgentsClient,
} from "@nylorun/agents";
import { CliError } from "../errors.js";

export const accessUsage = `nylo access signing-keys <list|rotate|revoke>

  signing-keys list                  list the signing keys
  signing-keys rotate [--force]      rotate; --force ends outstanding delivery tokens and links
  signing-keys revoke <kid>          revoke a previous or standby key`;

const usageError = (message = accessUsage) => new CliError(message, 2);

async function linkedClient(): Promise<AgentsClient> {
  let connection;
  try {
    connection = await resolveConnection();
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 1);
  }
  return createClient({ url: connection.url, key: connection.key });
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export async function accessCommand(
  input: readonly string[],
  client: () => Promise<AgentsClient> = linkedClient
): Promise<void> {
  const [topic, action, ...args] = input;
  if (topic === "signing-keys") {
    const keys = async () => (await client()).access.signingKeys;
    if (action === "list" && args.length === 0) return print(await (await keys()).list());
    if (action === "rotate") {
      const force = args[0] === "--force";
      if (args.length > (force ? 1 : 0)) throw usageError();
      return print(await (await keys()).rotate({ force }));
    }
    if (action === "revoke" && args.length === 1)
      return print(await (await keys()).revoke(args[0]!));
    throw usageError();
  }
  if (topic === "policy" || topic === "keys" || topic === "revoke" || topic === "token")
    throw usageError(
      `nylo access ${topic} was removed: the Runtime no longer mints subject tokens or keeps an access policy, browser keys or revocations (protocol 7). Trust your identity provider's tokens with an identity file, and give servers an operator key (nylorun key put <id>).`
    );
  throw usageError();
}
