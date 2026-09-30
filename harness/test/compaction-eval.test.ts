/**
 * Compaction evaluation (Model Calls W1.5). Opt-in: it calls a real model.
 *
 *   NYLORUN_TEST_MODEL_URL=http://127.0.0.1:11434/v1 NYLORUN_TEST_MODEL=qwen3:8b \
 *     npm run eval:compaction -w @nylorun/harness
 *
 * Each scenario is a long session whose facts are stated early. After compaction, the model
 * answers each fact's question from the summary alone; the score is the share it gets right.
 * The target is 90%. The result is recorded in the implementation plan, not asserted in CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelAdapter, ModelCall, TranscriptEntry } from "@nylorun/core/define";
import { chatCompletionsAdapter } from "../src/loop/model/adapters.js";
import { compact, summaryPrompt } from "../src/loop/compaction/index.js";

const url = process.env.NYLORUN_TEST_MODEL_URL;
const modelId = process.env.NYLORUN_TEST_MODEL ?? "default";
const key = process.env.NYLORUN_TEST_MODEL_KEY ?? "none";

type Scenario = {
  name: string;
  request: string;
  facts: { at: "user" | "tool"; text: string; question: string; answer: string }[];
};
const { scenarios } = JSON.parse(
  readFileSync(new URL("./fixtures/compaction-eval.json", import.meta.url), "utf8"),
) as { scenarios: Scenario[] };

function session(scenario: Scenario): TranscriptEntry[] {
  const turnId = `turn-${scenario.name}`;
  const entries: TranscriptEntry[] = [
    { kind: "input", turnId, event: { kind: "user-message", text: scenario.request } },
  ];
  let step = 0;
  const toolStep = (output: string) => {
    const id = `call-${step}`;
    entries.push(
      {
        kind: "candidate",
        turnId,
        stepId: `s${step}`,
        candidate: {
          output: [
            { type: "text", text: `Checking the next part of the task (step ${step}).` },
            { type: "tool-call", id, name: "inspect", args: { step } },
          ],
        },
      },
      {
        kind: "tool-results",
        turnId,
        stepId: `s${step}`,
        results: [{ kind: "completed", callId: id, toolName: "inspect", output }],
      },
    );
    step++;
  };
  for (const fact of scenario.facts) {
    if (fact.at === "user")
      entries.push({ kind: "input", turnId, event: { kind: "user-message", text: fact.text } });
    else toolStep(fact.text);
    // Unrelated tool output between facts, so the facts end up in the summarized part.
    for (let filler = 0; filler < 6; filler++)
      toolStep(
        `Routine check ${filler} passed. ${"Nothing unusual in this log line. ".repeat(40)}`,
      );
  }
  return entries;
}

/** A local model can think longer than fetch waits for a response; one retry covers it. */
async function post(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if ((init.signal as AbortSignal | undefined)?.aborted) throw error;
    return fetch(url, init);
  }
}

const adapter: ModelAdapter = chatCompletionsAdapter(async (request, _call, context) => {
  const response = await post(`${url!.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ ...request, model: modelId }),
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Model returned ${response.status}: ${await response.text()}`);
  return response.json();
});

async function ask(summary: string, question: string): Promise<string> {
  const call: ModelCall = {
    executionId: "eval",
    tools: [],
    model: { controls: { maxOutputTokens: 200 } },
    prompt: [
      {
        kind: "instructions",
        role: "system",
        content: [{ type: "text", text: "Answer briefly from the summary only." }],
      },
      {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: `${summary}\n\n${question}` }],
      },
    ],
  };
  const outcome = await adapter(call, {
    request: {} as never,
    invocationId: "question",
    signal: AbortSignal.timeout(600_000),
    reportPreparedCall() {},
  });
  if (typeof outcome === "string") return outcome;
  if (!("output" in outcome)) return "";
  return outcome.output.map((block) => (block.type === "text" ? block.text : "")).join("");
}

it.skipIf(!url)(
  "keeps the facts a long session needs after compaction",
  async () => {
    let right = 0;
    let total = 0;
    const results: {
      scenario: string;
      question: string;
      expected: string;
      answer: string;
      ok: boolean;
    }[] = [];
    const summaries: Record<string, string> = {};
    // Vitest hides a passing test's console output, so the report goes to a file, after
    // every scenario so a slow model still leaves partial results.
    const report =
      process.env.NYLORUN_EVAL_REPORT ?? join(tmpdir(), "nylorun-compaction-eval.json");
    const write = () => {
      const score = `${right}/${total} (${total ? Math.round((right / total) * 100) : 0}%)`;
      writeFileSync(report, JSON.stringify({ model: modelId, score, results, summaries }, null, 2));
      return score;
    };
    // NYLORUN_EVAL_ONLY=name,name runs some scenarios, e.g. to finish an interrupted run.
    const only = process.env.NYLORUN_EVAL_ONLY?.split(",").map((name) => name.trim());
    for (const scenario of scenarios.filter((item) => !only || only.includes(item.name))) {
      const transcript = session(scenario);
      const compacted = await compact({
        transcript,
        executionId: "eval",
        turnId: `turn-${scenario.name}`,
        stepId: "eval",
        trigger: "threshold",
        // Small enough that the kept tail excludes the facts.
        budget: { contextWindow: 4_000, reserve: 1_000 },
        invoke: adapter,
        signal: AbortSignal.timeout(1_800_000),
      });
      expect(compacted?.[0]?.kind).toBe("compaction");
      const entry = compacted![0]!;
      if (entry.kind !== "compaction") continue;
      summaries[scenario.name] = entry.summary;
      for (const fact of scenario.facts) {
        total++;
        const answer = await ask(summaryPrompt(entry), fact.question);
        const ok = answer.toLowerCase().includes(fact.answer.toLowerCase());
        if (ok) right++;
        results.push({
          scenario: scenario.name,
          question: fact.question,
          expected: fact.answer,
          answer: answer.trim(),
          ok,
        });
      }
      write();
    }
    process.stdout.write(`Compaction eval with ${modelId}: ${write()}. Report: ${report}\n`);
  },
  7_200_000,
);
