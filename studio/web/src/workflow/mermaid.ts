import {
  ROOT_POSITION,
  childPosition,
  leafPart,
  type WorkflowHttpTarget,
  type WorkflowHttpVerify,
  type WorkflowManifest,
  type WorkflowNode,
} from "./types.ts";

/**
 * A flow agent's manifest (workflow manifest v3) as a Mermaid flowchart, top to bottom: Start,
 * its stages, End. A chain is a sequence; a switch a decision with an edge per case; a parallel
 * a fork with an edge per branch, all of which meet the next stage; a map over one stage that
 * stage as a stack (it runs once per item), over several a box around them; a loop its body and
 * verifier, with a dotted retry edge back; an embedded flow agent a box holding its own stages.
 * Agents are rounded boxes, tools and HTTP stages subroutines with their request on a second
 * line. The text carries its own zinc `classDef`s (DESIGN.md: no color outside charts), so it
 * reads the same pasted anywhere. Needs Mermaid 11.3 or later (the stack shape).
 */
export function mermaidFromManifest(manifest: WorkflowManifest): string {
  const lines: string[] = ["flowchart TD"];
  let count = 0;
  const next = (): string => `n${++count}`;
  const start = next();
  lines.push(`  ${start}(["Start"]):::terminal`);
  const body = walk(manifest, manifest.root, ROOT_POSITION, { lines, next, depth: 1 });
  connect(lines, [{ id: start }], body.entry);
  const end = next();
  lines.push(`  ${end}(["End"]):::terminal`);
  connect(lines, body.exits, end);
  lines.push(...CLASS_DEFS);
  return `${lines.join("\n")}\n`;
}

/** Zinc and white, as DESIGN.md sets every diagram. */
const CLASS_DEFS = [
  "  classDef terminal fill:#09090b,stroke:#09090b,color:#ffffff",
  "  classDef agent fill:#ffffff,stroke:#a1a1aa,color:#09090b",
  "  classDef tool fill:#f4f4f5,stroke:#a1a1aa,color:#09090b",
  "  classDef control fill:#ffffff,stroke:#71717a,color:#09090b",
];

/** Where a stage starts, and the nodes (with an edge label) that lead on to the next one. */
type Span = { readonly entry: string; readonly exits: readonly Exit[] };
type Exit = { readonly id: string; readonly label?: string };
type Out = { readonly lines: string[]; readonly next: () => string; readonly depth: number };

/** A label Mermaid reads as text: quoted, its quotes and markup escaped; lines join with a break. */
function text(...lines: string[]): string {
  const escape = (value: string) =>
    value.replace(/&/g, "#amp;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
  return `"${lines.map(escape).join("<br/>")}"`;
}

/** A leaf stage (an agent or a tool, not an embedded flow), which a map draws as one stack. */
function isLeaf(flow: WorkflowManifest, node: WorkflowNode): boolean {
  if ("tool" in node) return true;
  if (!("agent" in node)) return false;
  return (flow.agents[node.agent] as { readonly kind?: string } | undefined)?.kind !== "workflow";
}

function connect(lines: string[], from: readonly Exit[], to: string): void {
  for (const exit of from)
    lines.push(exit.label ? `  ${exit.id} -->|${text(exit.label)}| ${to}` : `  ${exit.id} --> ${to}`);
}

/** A request as a short line: its method and host, such as `POST hooks.example.com`. */
function request(http: WorkflowHttpTarget): string {
  let host = http.url;
  try {
    host = new URL(http.url).host;
  } catch {
    /* Not an absolute URL: shown as it is. */
  }
  return `${http.method ?? "POST"} ${host}`;
}

function walk(
  flow: WorkflowManifest,
  node: WorkflowNode | WorkflowHttpVerify,
  position: string,
  out: Out,
): Span {
  const { lines, next } = out;
  const pad = "  ".repeat(out.depth);
  if ("http" in node) {
    const id = next();
    lines.push(`${pad}${id}[[${text("verify", request(node.http))}]]:::tool`);
    return { entry: id, exits: [{ id }] };
  }
  if ("agent" in node) {
    const embedded = flow.agents[node.agent] as (WorkflowManifest & { readonly kind?: string }) | undefined;
    if (embedded?.kind === "workflow") {
      const box = next();
      lines.push(`${pad}subgraph ${box}[${text(`flow · ${leafPart(node)!}`)}]`);
      const inner = walk(embedded, embedded.root, ROOT_POSITION, { ...out, depth: out.depth + 1 });
      lines.push(`${pad}end`);
      return inner;
    }
    const id = next();
    lines.push(`${pad}${id}(${text(leafPart(node)!)}):::agent`);
    return { entry: id, exits: [{ id }] };
  }
  if ("tool" in node) {
    const id = next();
    const name = leafPart(node)!;
    lines.push(`${pad}${id}[[${node.tool.http ? text(name, request(node.tool.http)) : text(name)}]]:::tool`);
    return { entry: id, exits: [{ id }] };
  }
  const name = node.id;
  const inner = (child: WorkflowNode, at: string | number) =>
    walk(flow, child, childPosition(position, at), out);
  if ("chain" in node) {
    const spans = node.chain.map((step, index) => inner(step, index));
    if (spans.length === 0) {
      const id = next();
      lines.push(`${pad}${id}[${text(name ?? "empty chain")}]:::control`);
      return { entry: id, exits: [{ id }] };
    }
    for (let index = 1; index < spans.length; index++)
      connect(lines, spans[index - 1]!.exits, spans[index]!.entry);
    return { entry: spans[0]!.entry, exits: spans.at(-1)!.exits };
  }
  if ("switch" in node) {
    const id = next();
    lines.push(`${pad}${id}{${text(name ?? "switch")}}:::control`);
    const cases: [string, WorkflowNode][] = [
      ...Object.entries(node.switch.cases),
      ...(node.switch.default ? [["default", node.switch.default] as [string, WorkflowNode]] : []),
    ];
    const exits: Exit[] = [];
    for (const [label, child] of cases) {
      const span = inner(child, label);
      lines.push(`  ${id} -->|${text(label)}| ${span.entry}`);
      exits.push(...span.exits);
    }
    return { entry: id, exits };
  }
  if ("parallel" in node) {
    const id = next();
    lines.push(`${pad}${id}{{${text(`${name ?? "parallel"} · all`)}}}:::control`);
    const exits: Exit[] = [];
    for (const [label, child] of Object.entries(node.parallel)) {
      const span = inner(child, label);
      lines.push(`  ${id} -->|${text(label)}| ${span.entry}`);
      exits.push(...span.exits);
    }
    return { entry: id, exits };
  }
  if ("map" in node) {
    const each = node.map.each;
    if (isLeaf(flow, each)) {
      const id = next();
      const kind = "tool" in each ? "tool" : "agent";
      lines.push(`${pad}${id}@{ shape: procs, label: ${text(leafPart(each)!, name ? `for each item in ${name}` : "for each item")} }`);
      lines.push(`${pad}class ${id} ${kind}`);
      return { entry: id, exits: [{ id }] };
    }
    const box = next();
    lines.push(`${pad}subgraph ${box}[${text(`${name ?? "map"} · for each item`)}]`);
    const span = walk(flow, node.map.each, childPosition(position, "each"), { ...out, depth: out.depth + 1 });
    lines.push(`${pad}end`);
    return span;
  }
  if ("loop" in node) {
    const run = walk(flow, node.loop.run, childPosition(position, "run"), out);
    const verify = walk(flow, node.loop.verify, childPosition(position, "verify"), out);
    connect(lines, run.exits, verify.entry);
    const retry = `retry · up to ${node.loop.max} ${node.loop.max === 1 ? "time" : "times"}`;
    for (const exit of verify.exits) lines.push(`  ${exit.id} -.->|${text(retry)}| ${run.entry}`);
    return { entry: run.entry, exits: verify.exits.map((exit) => ({ id: exit.id, label: "passes" })) };
  }
  throw new Error("Unknown workflow node");
}

/** How many stages run an agent, and how many a tool or an HTTP request, embedded flows included. */
export function flowStageCounts(manifest: WorkflowManifest): { agents: number; tools: number } {
  const counts = { agents: 0, tools: 0 };
  const visit = (flow: WorkflowManifest, node: WorkflowNode | WorkflowHttpVerify): void => {
    if ("http" in node || "tool" in node) counts.tools += 1;
    else if ("agent" in node) {
      const embedded = flow.agents[node.agent] as (WorkflowManifest & { readonly kind?: string }) | undefined;
      if (embedded?.kind === "workflow") visit(embedded, embedded.root);
      else counts.agents += 1;
    } else if ("chain" in node) for (const step of node.chain) visit(flow, step);
    else if ("switch" in node) {
      for (const child of Object.values(node.switch.cases)) visit(flow, child);
      if (node.switch.default) visit(flow, node.switch.default);
    } else if ("parallel" in node) for (const child of Object.values(node.parallel)) visit(flow, child);
    else if ("map" in node) visit(flow, node.map.each);
    else if ("loop" in node) {
      visit(flow, node.loop.run);
      visit(flow, node.loop.verify);
    }
  };
  visit(manifest, manifest.root);
  return counts;
}
