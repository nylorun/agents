/**
 * `nylo access`: the linked Tenant's signing keys, which sign delivery tokens and capability
 * links, through the Management API with the Project's management key. (Subject tokens, the
 * access policy, browser keys and revocations left the Runtime in protocol 7.)
 */
import type { ManagementClient } from "@nylorun/admin";
import { CliError } from "../errors.js";
import { linkedConnection, managementClient } from "../project/connection.js";
import { findProjectRoot } from "../project/root.js";

export const accessUsage = `nylo access signing-keys <list|rotate|revoke>

  signing-keys list                  list the signing keys
  signing-keys rotate [--force]      rotate; --force ends outstanding delivery tokens and links
  signing-keys revoke <kid>          revoke a previous or standby key`;

const usageError = (message = accessUsage) => new CliError(message, 2);

async function linkedClient(): Promise<ManagementClient> {
  return managementClient(await linkedConnection(findProjectRoot() ?? process.cwd()));
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export async function accessCommand(
  input: readonly string[],
  client: () => Promise<ManagementClient> = linkedClient
): Promise<void> {
  const [topic, action, ...args] = input;
  if (topic === "signing-keys") {
    const keys = async () => (await client()).signingKeys;
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
      `nylo access ${topic} was removed: the Runtime no longer mints subject tokens or keeps an access policy, browser keys or revocations (protocol 7). Trust your identity provider's tokens with an identity file, and give servers an application key (nylorun key put <id>).`
    );
  throw usageError();
}
