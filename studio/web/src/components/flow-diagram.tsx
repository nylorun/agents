import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { flowStageCounts, mermaidFromManifest, type WorkflowManifest } from "@/workflow";

type Mermaid = (typeof import("mermaid"))["default"];

/**
 * Mermaid in DESIGN.md's zinc and white: a diagram is not a chart, so it takes no Sage. Flat
 * (the classic look), DM Sans, edges and their labels in muted-foreground. Strict, so a label is
 * text: Mermaid escapes it and sanitizes the SVG it returns.
 */
const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  look: "classic",
  flowchart: { curve: "basis", padding: 12, nodeSpacing: 28, rankSpacing: 36, htmlLabels: true, wrappingWidth: 240 },
  themeVariables: {
    fontFamily: "DM Sans Variable, DM Sans, ui-sans-serif, system-ui, sans-serif",
    fontSize: "13px",
    primaryColor: "#ffffff",
    primaryTextColor: "#09090b",
    primaryBorderColor: "#a1a1aa",
    lineColor: "#71717a",
    textColor: "#09090b",
    clusterBkg: "#ffffff",
    clusterBorder: "#e4e4e7",
    edgeLabelBackground: "#ffffff",
    titleColor: "#71717a",
  },
  themeCSS: ".edgeLabel, .edgeLabel p, .edgeLabel span { color: #71717a; }",
} as const;

let mermaidLoad: Promise<Mermaid> | undefined;
/** Mermaid is large: it loads the first time a flow is drawn, in its own chunk. */
function loadMermaid(): Promise<Mermaid> {
  mermaidLoad ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_CONFIG);
    return mermaid;
  });
  return mermaidLoad;
}

type Drawn = { kind: "drawing" } | { kind: "drawn"; svg: string } | { kind: "failed"; message: string };

/** The shapes the diagram draws, as the legend shows them. */
const LEGEND: readonly [string, string][] = [
  ['<rect x="1.5" y="2.5" width="17" height="9" rx="3" fill="#ffffff" stroke="#a1a1aa"/>', "Agent"],
  [
    '<rect x="1.5" y="2.5" width="17" height="9" fill="#f4f4f5" stroke="#a1a1aa"/><path d="M4.5 2.5v9M15.5 2.5v9" stroke="#a1a1aa"/>',
    "Tool or HTTP stage",
  ],
  ['<path d="M10 1.5 15.5 7 10 12.5 4.5 7Z" fill="#ffffff" stroke="#71717a"/>', "Switch: one case"],
  ['<path d="M5 2.5h10l3.5 4.5-3.5 4.5H5L1.5 7Z" fill="#ffffff" stroke="#71717a"/>', "Parallel: every branch"],
  [
    '<rect x="5.5" y="1.5" width="13" height="8" fill="#ffffff" stroke="#a1a1aa"/><rect x="1.5" y="4.5" width="13" height="8" fill="#ffffff" stroke="#a1a1aa"/>',
    "For each item",
  ],
  ['<path d="M1.5 7h17" stroke="#71717a" stroke-dasharray="3 2"/>', "Retry"],
];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A flow agent's stages as a diagram (Mermaid), top to bottom as its manifest declares them,
 * with a legend and the Mermaid text to copy: the Flow section of a manifest's spec
 * (`ManifestSpec`), `id` its anchor and `hint` the version it draws. A run's progress stays on
 * the session's Events tab.
 */
export function FlowDiagram({
  manifest,
  id: anchor,
  hint = "Its stages, top to bottom, as the manifest declares them",
  gutter = "px-4",
}: Readonly<{ manifest: WorkflowManifest; id?: string; hint?: string; gutter?: "px-4" | "px-5" }>) {
  const text = useMemo(() => mermaidFromManifest(manifest), [manifest]);
  const counts = useMemo(() => flowStageCounts(manifest), [manifest]);
  // Mermaid names the SVG's elements after this id, so it is unique and a valid selector.
  const id = `flow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<Drawn>({ kind: "drawing" });
  const [copy, setCopy] = useState<"idle" | "copied" | "shown">("idle");
  const source = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDrawn({ kind: "drawing" });
    loadMermaid()
      .then((mermaid) => mermaid.render(id, text))
      .then(
        ({ svg }) => {
          if (!cancelled) setDrawn({ kind: "drawn", svg });
        },
        (cause: unknown) => {
          if (!cancelled) setDrawn({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [id, text]);

  useEffect(() => {
    if (copy === "shown" && source.current) window.getSelection()?.selectAllChildren(source.current);
  }, [copy]);

  const copyText = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopy("copied");
        window.setTimeout(() => setCopy("idle"), 2000);
      },
      // The clipboard can be refused (an embedded frame, no permission): show the text, selected.
      () => setCopy("shown"),
    );
  };

  const copyButton = (
    <Button variant="outline" size="sm" className="shrink-0" onClick={copyText}>
      {copy === "copied" ? <Check /> : <Copy />}
      {copy === "copied" ? "Copied" : "Copy Mermaid"}
    </Button>
  );
  const body = (
    <>
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {LEGEND.map(([shape, label]) => (
          <li key={label} className="inline-flex items-center gap-1.5">
            <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden dangerouslySetInnerHTML={{ __html: shape }} />
            {label}
          </li>
        ))}
      </ul>
      <figure className="m-0 rounded-lg border bg-background p-4">
        {drawn.kind === "drawn" ? (
          <div
            role="img"
            aria-label="The flow's stages as a diagram"
            className="[&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
            // Mermaid's own SVG, from strict mode: labels are escaped and the markup sanitized.
            dangerouslySetInnerHTML={{ __html: drawn.svg }}
          />
        ) : drawn.kind === "drawing" ? (
          <div aria-busy="true" aria-label="Drawing the flow" className="mx-auto flex max-w-xs flex-col items-center gap-3">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-9 w-40" />
            ))}
          </div>
        ) : (
          <p role="alert" className="text-sm">
            The diagram could not be drawn: {drawn.message}
          </p>
        )}
      </figure>
      {copy === "shown" || drawn.kind === "failed" ? (
        <pre
          ref={source}
          aria-label="Mermaid source"
          className="overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-5"
        >
          {text}
        </pre>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {plural(counts.agents, "agent stage", "agent stages")} and {plural(counts.tools, "tool stage", "tool stages")} · a
        stage is named by its id, else its agent or tool. A run's progress is on its session's Events tab.
      </p>
    </>
  );

  return (
    <section id={anchor} aria-label="Flow" className="scroll-mt-2">
      <div className={cn("flex items-center gap-2 border-b pt-4 pb-1.5", gutter)}>
        <h3 className="text-[13px] font-medium">Flow</h3>
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
        <span className="ml-auto" />
        {copyButton}
      </div>
      <div className={cn("space-y-3 py-3", gutter)}>{body}</div>
    </section>
  );
}
