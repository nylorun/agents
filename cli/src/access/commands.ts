/**
 * `nylo access`: the linked Tenant's access policy, signing keys and revocations, and a
 * development command that mints a subject token (Host feature `subject-tokens`). Uses the
 * Project's application key, like every other Tenant command.
 */
import { readFile } from "node:fs/promises";
import {
  createClient,
  resolveConnection,
  type AgentsClient,
} from "@nylorun/agents";
import { CliError } from "../errors.js";

export const accessUsage = `nylo access <policy|keys|signing-keys|revoke|token>

  policy get                         print the access policy
  policy set <file>                  replace it with a JSON file
  policy init                        write a starter "user" role (sessions:own agents:read, every agent,
                                     60 turns per hour, 2 at once)
  signing-keys list                  list the signing keys
  signing-keys rotate [--force]      rotate; --force signs outstanding tokens out
  signing-keys revoke <kid>          revoke a previous or standby key
  keys list                          list the publishable keys
  keys create --name <n> [--origin <o>]…
                                     a publishable key for a web page or an app
                                     (origins: https://app.example.com or http://localhost:*)
  keys set-origins <id> [<o>…]       replace a key's origins ([] for native apps only)
  keys revoke <id>                   revoke a publishable key
  revoke <subject>                   end a subject's tokens and open streams
  token --subject <s> --role <r> [--ttl <seconds>]
                                     mint a subject token (for trying the API with curl)`;

/** The starter policy `policy init` writes. */
export const STARTER_POLICY = {
  version: 1,
  roles: {
    user: {
      scopes: ["sessions:own", "agents:read"],
      agents: "*",
      limits: { turnsPerHour: 60, concurrentTurns: 2 },
    },
  },
  anon: { scopes: [], agents: [] },
  tokens: { maxTtlSeconds: 600 },
} satisfies AccessPolicy;

type AccessPolicy = Parameters<AgentsClient["access"]["putPolicy"]>[0];

const usageError = (message = accessUsage) => new CliError(message, 2);

async function linkedClient(): Promise<AgentsClient> {
  let connection;
  try {
    connection = await resolveConnection();
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 1);
  }
  return createClient({
    url: connection.url,
    key: connection.key,
    tenant: connection.tenant,
  });
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw usageError(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

export async function accessCommand(
  input: readonly string[],
  client: () => Promise<AgentsClient> = linkedClient
): Promise<void> {
  const [topic, action, ...rest] = input;
  const args = [...rest];
  if (topic === "policy") {
    if (action === "get" && args.length === 0)
      return print(await (await client()).access.getPolicy());
    if (action === "init" && args.length === 0)
      return print(await (await client()).access.putPolicy(STARTER_POLICY));
    if (action === "set" && args.length === 1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(args[0]!, "utf8"));
      } catch (error) {
        throw new CliError(
          `Could not read ${args[0]}: ${error instanceof Error ? error.message : String(error)}`,
          1
        );
      }
      // Accept the file as the policy itself or as `{ policy }`, as `policy get` prints it.
      const candidate =
        parsed && typeof parsed === "object" && "policy" in parsed
          ? (parsed as { policy: unknown }).policy
          : parsed;
      // The Runtime validates it and names what is wrong.
      return print(
        await (await client()).access.putPolicy(candidate as AccessPolicy)
      );
    }
    throw usageError();
  }
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
  if (topic === "keys") {
    const keys = async () => (await client()).access.publishableKeys;
    if (action === "list" && args.length === 0) return print(await (await keys()).list());
    if (action === "create") {
      const name = option(args, "--name");
      const origins: string[] = [];
      for (let origin = option(args, "--origin"); origin; origin = option(args, "--origin"))
        origins.push(origin);
      if (!name || args.length > 0) throw usageError();
      return print(await (await keys()).create({ name, origins }));
    }
    if (action === "set-origins" && args.length >= 1) {
      const [keyId, ...origins] = args;
      return print(await (await keys()).update(keyId!, { origins }));
    }
    if (action === "revoke" && args.length === 1)
      return print(await (await keys()).revoke(args[0]!));
    throw usageError();
  }
  if (topic === "revoke") {
    if (!action || args.length > 0) throw usageError();
    return print(await (await client()).access.revokeSubject(action));
  }
  if (topic === "token") {
    const all = [action, ...args].filter((arg): arg is string => arg !== undefined);
    const subject = option(all, "--subject");
    const role = option(all, "--role");
    const ttl = option(all, "--ttl");
    if (!subject || !role || all.length > 0) throw usageError();
    const ttlSeconds = ttl === undefined ? undefined : Number(ttl);
    if (ttlSeconds !== undefined && !Number.isInteger(ttlSeconds))
      throw usageError("--ttl must be a whole number of seconds.");
    return print(
      await (await client()).tokens.create({
        subject,
        role,
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      })
    );
  }
  throw usageError();
}
