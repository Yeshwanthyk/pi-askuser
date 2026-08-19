/**
 * Vertical slice: a fake opencode-go/DeepSeek-style streaming endpoint feeding
 * a noisy `ask_user` tool call through the REAL pi-ai provider pipeline
 * (stream parse -> argument preparation -> schema validation -> headless
 * dialog interaction).
 *
 * GPT/Codex enforce strict structured outputs, so their ask_user arguments are
 * always canonical. DeepSeek (via opencode-go or api.deepseek.com) advertises
 * strict mode but does not enforce it: extra keys, string booleans, and null
 * optional fields come back. Before the tolerant normalization in
 * `normalizeAskUserArguments`, validation threw and the dialog never opened.
 *
 * The pi-ai runtime is resolved with a preference ladder so the test walks the
 * same code the running pi does (runtime 0.84.x first, then this repo's vendored
 * pi-coding-agent), skipping when neither is present.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import { Check } from "typebox/value";
import {
  AskUserParams,
  buildAskUserDetails,
  normalizeAskUserArguments,
  parseAskUserArguments,
  runDialogInteraction,
  type AskUserAnswer,
  type AskUserInput,
} from "./index.ts";
import { buildAskUserResultMessage } from "./prompt.ts";

function resolvePiAiDir(): string | undefined {
  const explicit = process.env.PI_ASKUSER_PI_AI_DIR;
  if (explicit && existsSync(join(explicit, "dist", "api", "openai-completions.js"))) return explicit;
  // Runtime pi (global install) is the closest stand-in for the live env.
  const nvm = "/Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai";
  if (existsSync(join(nvm, "dist", "api", "openai-completions.js"))) return nvm;
  // This repo's vendored pi-coding-agent.
  const vendored = join(dirname(new URL(import.meta.url).pathname), "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai");
  if (existsSync(join(vendored, "dist", "api", "openai-completions.js"))) return vendored;
  return undefined;
}

const piAiDir = resolvePiAiDir();
const openaiCompletionsUrl = piAiDir ? pathToFileURL(join(piAiDir, "dist", "api", "openai-completions.js")).href : undefined;

const messyArgs = {
  questions: [
    {
      id: "stack",
      question: "Which stack?",
      header: null,
      optional: "false",
      type: "choice", // DeepSeek-style unknown question key
      options: [
        { label: "Node", checked: true }, // unknown option key
        { label: "Go", aside: "faster" }, // Claude-style aside
      ],
    },
  ],
};

/** Sneaky-but-legal provider noise: DeepSeek often wraps nothing but a single
 * quote/bracket set across many deltas; keep it legal JSON over fragments. */
const argumentsFragments = [
  '{"questions":[{"id":"stack","question":"Which stack?"',
  ',"header":null,"optional":"false","type":"choice","options":[{"label":"Node","checked":true},{"label":"Go","aside":"faster"}',
  "]}]}",
];

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function startFakeOpenCodeGo(requestCapture: { params: unknown }): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          requestCapture.params = JSON.parse(body);
        } catch {
          requestCapture.params = undefined;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        // DeepSeek signature: reasoning_content -> blank text -> tool call -> finish.
        res.write(sse({
          id: "chatcmpl-1", object: "chat.completion.chunk", model: "deepseek-v4-flash",
          choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "Let me ask the user." } }],
        }));
        for (const fragment of argumentsFragments) {
          res.write(sse({
            id: "chatcmpl-1", object: "chat.completion.chunk", model: "deepseek-v4-flash",
            choices: [{
              index: 0,
              delta: { content: "", tool_calls: [{ index: 0, id: "call_ds_1", type: "function", function: { name: "ask_user", arguments: fragment } }] },
            }],
          }));
        }
        res.write(sse({
          id: "chatcmpl-1", object: "chat.completion.chunk", model: "deepseek-v4-flash",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const model = (baseUrl: string) => ({
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  provider: "opencode-go",
  baseUrl,
  reasoning: true,
  input: ["text"],
  cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 384000,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek",
  },
  thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
});

const toolDefinition = {
  name: "ask_user",
  label: "Ask User",
  description: "Ask 1-10 independent single- or multi-select questions answerable now.",
  parameters: AskUserParams,
  prepareArguments: (args: unknown) => parseAskUserArguments(normalizeAskUserArguments(args)),
};

function interactionQuestions(input: AskUserInput) {
  return input.questions.map((question) => ({
    id: question.id,
    question: question.question,
    options: question.options,
    optional: question.optional ?? false,
    multiSelect: question.multiSelect ?? false,
  }));
}

function stubDialogUI() {
  const calls: string[] = [];
  return {
    ui: {
      async select(_title: string, options: string[]) {
        calls.push(options[0] ?? "");
        return options[0];
      },
      async input(_title: string) {
        return undefined;
      },
      notify() {},
    },
    calls,
  };
}

test("opencode-go/deepseek-v4-flash fake endpoint survives the full ask_user pipeline", async (t) => {
  if (!openaiCompletionsUrl) {
    t.skip("pi-ai not resolvable; set PI_ASKUSER_PI_AI_DIR to the pi-ai package dir");
    return;
  }
  const { stream } = await import(openaiCompletionsUrl);
  const { validateToolArguments } = await import(pathToFileURL(join(piAiDir!, "dist", "utils", "validation.js")).href);

  const capture: { params: unknown } = { params: undefined };
  const server = await startFakeOpenCodeGo(capture);
  try {
    const port = (server.address() as { port: number }).port;
    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Ask me which stack to use." }],
      tools: [toolDefinition],
    };
    const events = [];
    let toolCall: { name: string; arguments: unknown } | undefined;
    for await (const event of stream(model(`http://127.0.0.1:${port}/v1`), context, { apiKey: "test-key" })) {
      events.push(event.type);
      if (event.type === "toolcall_end" && (event as { toolCall: { name: string; arguments: unknown } }).toolCall.name === "ask_user") {
        toolCall = (event as { toolCall: { name: string; arguments: unknown } }).toolCall;
      }
      if (event.type === "done" || event.type === "error") break;
    }

    // ask_user never opts into constrained sampling, so pi sends strict: false
    // and the backend promises no schema enforcement. GPT/Codex self-enforce
    // anyway; DeepSeek-style emitters do not, which is why their noisy
    // arguments used to fail validation before the dialog ever opened.
    const params = capture.params as { tools?: Array<{ function?: { name?: string; strict?: boolean } }> };
    const askUserTool = params?.tools?.find((t) => t.function?.name === "ask_user");
    assert.equal(askUserTool?.function?.strict, false);
    assert.ok(events.includes("thinking_delta"), "DeepSeek-style reasoning_content should parse as thinking");
    assert.ok(toolCall, "stream should parse the ask_user tool call");
    assert.deepEqual(toolCall!.arguments, messyArgs);

    // Pre-fix behavior: the noisy arguments fail schema validation (this is the
    // throw that previously produced the error result before the dialog opened).
    assert.throws(() => validateToolArguments(toolDefinition, { name: "ask_user", arguments: toolCall!.arguments }), /Validation failed/);
    assert.equal(Check(AskUserParams, toolCall!.arguments), false);

    // The fix: prepareArguments normalizes provider noise before validation.
    const prepared = toolDefinition.prepareArguments(structuredClone(toolCall!.arguments));
    assert.deepEqual(prepared, {
      questions: [{ id: "stack", question: "Which stack?", optional: false, options: [{ label: "Node" }, { label: "Go", description: "faster" }] }],
    });
    assert.doesNotThrow(() => validateToolArguments(toolDefinition, { name: "ask_user", arguments: prepared }));

    // Headless dialog path (what executes headlessly over RPC): the user picks
    // the first option and the result is built exactly as in `execute`.
    const { ui, calls } = stubDialogUI();
    const result = await runDialogInteraction(ui, prepared, interactionQuestions(prepared), undefined);
    assert.equal(result.status, "completed");
    const answers: AskUserAnswer[] = result.answers;
    assert.equal(answers.length, 1);
    const first = answers[0];
    if (first === undefined || first.multiSelect === true) throw new Error("expected a single-select answer");
    assert.equal(first.id, "stack");
    assert.equal(first.answer, "Node");
    assert.ok(calls.length > 0);

    const details = buildAskUserDetails(prepared, answers, [], result.status);
    assert.equal(details.status, "completed");
    const message = buildAskUserResultMessage({
      kind: result.status,
      questions: prepared.questions.map(({ id, question, optional }) => ({ id, question, optional: optional ?? false })),
      answers,
      skippedOptionalQuestionIds: [],
    });
    assert.match(message, /user selected option 1: Node/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
