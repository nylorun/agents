import assert from "node:assert/strict";
import test from "node:test";
import { flowStageCounts, mermaidFromManifest } from "../web/src/workflow/mermaid.ts";

const flow = (root, agents = {}) => ({ kind: "workflow", workflowSchemaVersion: 3, id: "f", root, agents });

test("a chain is Start, its stages in order, End, with zinc classes", () => {
  assert.equal(
    mermaidFromManifest(flow({ chain: [{ agent: "triage" }, { tool: { name: "open_pr" } }] }, { triage: { id: "triage" } })),
    [
      "flowchart TD",
      '  n1(["Start"]):::terminal',
      '  n2("triage"):::agent',
      '  n3[["open_pr"]]:::tool',
      "  n2 --> n3",
      "  n1 --> n2",
      '  n4(["End"]):::terminal',
      "  n3 --> n4",
      "  classDef terminal fill:#09090b,stroke:#09090b,color:#ffffff",
      "  classDef agent fill:#ffffff,stroke:#a1a1aa,color:#09090b",
      "  classDef tool fill:#f4f4f5,stroke:#a1a1aa,color:#09090b",
      "  classDef control fill:#ffffff,stroke:#71717a,color:#09090b",
      "",
    ].join("\n"),
  );
});

/** Every kind of stage: a switch, a parallel, a map, a loop, an HTTP stage and an embedded flow. */
const triage = flow(
  {
    chain: [
      { agent: "classify" },
      {
        id: "route",
        switch: {
          cases: {
            billing: { agent: "billing" },
            bug: { id: "investigate", parallel: { logs: { tool: { name: "search-logs", http: { url: "https://logs.internal/search", method: "GET" } } }, repro: { agent: "reproducer" } } },
          },
          default: { agent: "generalist" },
        },
      },
      { id: "attachments", map: { each: { agent: "summarizer" } } },
      { id: "reply", loop: { run: { agent: "drafter" }, verify: { http: { url: "https://qa.example.com/check" } }, max: 3 } },
      { agent: "review" },
    ],
  },
  {
    classify: { id: "classify" },
    billing: { id: "billing" },
    reproducer: { id: "reproducer" },
    generalist: { id: "generalist" },
    summarizer: { id: "summarizer" },
    drafter: { id: "drafter" },
    review: { kind: "workflow", workflowSchemaVersion: 3, id: "review", root: { chain: [{ agent: "reader" }, { agent: "judge" }] }, agents: { reader: { id: "reader" }, judge: { id: "judge" } } },
  },
);

test("a switch forks by case, a parallel by branch, and both meet the next stage", () => {
  const text = mermaidFromManifest(triage);
  assert.match(text, /n3\{"route"\}:::control/);
  assert.match(text, /n3 -->\|"billing"\| n4/);
  assert.match(text, /n5\{\{"investigate · all"\}\}:::control/);
  assert.match(text, /n6\[\["search-logs<br\/>GET logs\.internal"\]\]:::tool/);
  assert.match(text, /n5 -->\|"logs"\| n6/);
  assert.match(text, /n3 -->\|"default"\| n8/);
  // Each case's and branch's last stage leads on to the map.
  for (const from of ["n4", "n6", "n7", "n8"]) assert.match(text, new RegExp(`  ${from} --> n9\\n`));
});

test("a map over one stage is a stack; a loop retries its body until its verifier passes", () => {
  const text = mermaidFromManifest(triage);
  assert.match(text, /n9@\{ shape: procs, label: "summarizer<br\/>for each item in attachments" \}\n {2}class n9 agent/);
  assert.match(text, /n11\[\["verify<br\/>POST qa\.example\.com"\]\]:::tool/);
  assert.match(text, /n10 --> n11/);
  assert.match(text, /n11 -\.->\|"retry · up to 3 times"\| n10/);
  assert.match(text, /n11 -->\|"passes"\| n13/);
});

test("an embedded flow agent is a box of its own stages", () => {
  const text = mermaidFromManifest(triage);
  assert.match(text, /subgraph n12\["flow · review"\]\n {4}n13\("reader"\):::agent\n {4}n14\("judge"\):::agent\n {2}n13 --> n14\n {2}end/);
  // The box's last stage leads on to End.
  assert.match(text, /n15\(\["End"\]\):::terminal\n {2}n14 --> n15\n/);
});

test("a label is text: its quotes and markup are escaped", () => {
  const text = mermaidFromManifest(flow({ chain: [{ agent: "a", id: 'say "hi" <script>alert(1)</script> & go' }] }, { a: { id: "a" } }));
  assert.match(text, /\("say #quot;hi#quot; #lt;script#gt;alert\(1\)#lt;\/script#gt; #amp; go"\):::agent/);
  assert.doesNotMatch(text, /<script>/);
});

test("stage counts take in an embedded flow's stages and a loop's verifier", () => {
  assert.deepEqual(flowStageCounts(triage), { agents: 8, tools: 2 });
});
