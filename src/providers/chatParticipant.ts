import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ProvenanceStore, FunctionNode, SpecificationNode, BugNode, HazardNode } from "../provenance";

const PARTICIPANT_ID = "deeptest-provenance.deeptest";

interface DeepTestResult extends vscode.ChatResult {
  metadata: {
    command: string;
    functionId?: string;
    specIds?: string[];
  };
}

export function registerDeepTestParticipant(
  context: vscode.ExtensionContext,
  getStore: () => ProvenanceStore | undefined,
) {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<DeepTestResult> => {
    const store = getStore();

    if (!store) {
      stream.markdown(
        "⚠️ No provenance data loaded. Make sure `.deeptest/report/provenance.json` exists in your workspace.\n\n" +
        "Run DeepTest on your project first, then use **DeepTest: Refresh Provenance** to load the data.",
      );
      return { metadata: { command: "" } };
    }

    if (request.command === "specs") {
      return handleSpecs(request, store, stream, token);
    } else if (request.command === "bugs") {
      return handleBugs(request, store, stream, token);
    } else if (request.command === "review") {
      return handleReview(request, store, stream, token);
    } else {
      return handleFreeform(request, store, stream, chatContext, token);
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon("beaker");

  participant.followupProvider = {
    provideFollowups(result: DeepTestResult, _context, _token) {
      const followups: vscode.ChatFollowup[] = [];

      if (result.metadata.functionId) {
        followups.push({
          prompt: "What tests cover this function?",
          label: "Show tests",
        });
        followups.push({
          prompt: "Are there any hazards in this function?",
          label: "Show hazards",
        });
      }

      if (result.metadata.specIds?.length) {
        followups.push({
          prompt: "Generate a test for the first uncovered spec",
          label: "Generate test",
        });
      }

      return followups;
    },
  };

  context.subscriptions.push(participant);
}

// ── /specs command ──

async function handleSpecs(
  request: vscode.ChatRequest,
  store: ProvenanceStore,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
): Promise<DeepTestResult> {
  const func = resolveFunction(request.prompt, store);

  if (!func) {
    // Try current editor
    const editorFunc = getFunctionAtCursor(store);
    if (editorFunc) {
      return renderFunctionSpecs(editorFunc, store, stream);
    }
    stream.markdown("Specify a function name, or place your cursor in a function.\n\nUsage: `@deeptest /specs parse_expression`");
    return { metadata: { command: "specs" } };
  }

  return renderFunctionSpecs(func, store, stream);
}

function renderFunctionSpecs(
  func: FunctionNode,
  store: ProvenanceStore,
  stream: vscode.ChatResponseStream,
): DeepTestResult {
  const specs = store.getSpecsForFunction(func.id);
  const bugs = store.getBugsForFunction(func.id);
  const tests = store.getTestsForFunction(func.id);
  const summary = store.getFunctionSummary(func.id);

  // Function header
  stream.markdown(`## 📋 Specifications for \`${func.qualname}\`\n\n`);
  stream.markdown(`📍 \`${func.location.file}:${func.location.line}\`\n\n`);

  // Summary ring
  const coveredCount = specs.filter(s => s.status === "covered").length;
  const bugCount = specs.filter(s => s.status === "bug_associated").length;
  const untestedCount = specs.filter(s => s.status === "untested").length;
  stream.markdown(
    `> **${specs.length} specs**: ` +
    `✅ ${coveredCount} covered · ` +
    `🐛 ${bugCount} bug-associated · ` +
    `❓ ${untestedCount} untested\n\n`,
  );

  // Each spec as a claim card
  const specIds: string[] = [];
  for (const spec of specs) {
    specIds.push(spec.id);
    const statusIcon = spec.status === "covered" ? "✅" : spec.status === "bug_associated" ? "🐛" : "❓";
    const statusLabel = spec.status === "covered"
      ? "Covered by passing tests"
      : spec.status === "bug_associated"
        ? "Bug found in this function"
        : "No linked tests";

    stream.markdown(`### ${statusIcon} ${spec.direction.toUpperCase()}: \`${spec.expression}\`\n\n`);
    if (spec.description) {
      stream.markdown(`*${spec.description}*\n\n`);
    }
    stream.markdown(`Status: **${statusLabel}**\n\n`);
  }

  // Bugs summary
  if (bugs.length > 0) {
    stream.markdown(`---\n\n### 🐛 Bugs in this function\n\n`);
    for (const bug of bugs) {
      const sev = bug.triage?.severity ?? "unknown";
      const verdict = bug.triage?.verdict ?? "unknown";
      stream.markdown(
        `- **[${sev}]** ${bug.bug_type} (L${bug.location.line}): ${bug.description}\n` +
        `  - Verdict: ${verdict} · Recommendation: ${bug.triage?.recommendation ?? "?"}\n\n`,
      );
    }
  }

  // Test summary
  stream.markdown(`---\n\n📊 **${summary.tests} tests** (${summary.passing}✓ ${summary.failing}✗) · **${summary.hazards} hazards**\n\n`);

  // Action buttons
  if (untestedCount > 0) {
    stream.button({
      command: "deeptest.showProvenance",
      arguments: [func.id],
      title: "🧪 Show in Provenance Panel",
    });
  }

  // Reference the source file
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const fileUri = vscode.Uri.file(path.join(root, func.location.file));
    stream.reference(new vscode.Location(fileUri, new vscode.Position(func.location.line - 1, 0)));
  }

  return {
    metadata: {
      command: "specs",
      functionId: func.id,
      specIds,
    },
  };
}

// ── /bugs command ──

async function handleBugs(
  request: vscode.ChatRequest,
  store: ProvenanceStore,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
): Promise<DeepTestResult> {
  const allBugs = store.manifest.bugs;

  if (allBugs.length === 0) {
    stream.markdown("✅ No bugs found in the provenance data.\n");
    return { metadata: { command: "bugs" } };
  }

  stream.markdown(`## 🐛 ${allBugs.length} Bug${allBugs.length > 1 ? "s" : ""} Found\n\n`);

  // Group by severity
  const bySeverity: Record<string, BugNode[]> = {};
  for (const bug of allBugs) {
    const sev = bug.triage?.severity ?? "unknown";
    (bySeverity[sev] ??= []).push(bug);
  }

  for (const severity of ["critical", "high", "medium", "low"]) {
    const bugs = bySeverity[severity];
    if (!bugs?.length) { continue; }

    const icon = severity === "critical" || severity === "high" ? "🔴" : severity === "medium" ? "🟡" : "⚪";
    stream.markdown(`### ${icon} ${severity.toUpperCase()} (${bugs.length})\n\n`);

    for (const bug of bugs) {
      const func = bug.function_id ? store.getFunction(bug.function_id) : undefined;
      stream.markdown(
        `**${bug.bug_type}** in \`${func?.qualname ?? bug.location.file}\` (L${bug.location.line})\n\n` +
        `${bug.description}\n\n`,
      );

      if (bug.triage) {
        stream.markdown(
          `> Verdict: **${bug.triage.verdict}** · ` +
          `Reproduced: ${bug.triage.reproduced ?? "?"} · ` +
          `Triggerable: ${bug.triage.publicly_triggerable ?? "?"}\n\n`,
        );
      }

      if (bug.suggested_fix) {
        stream.markdown(`💡 **Fix:** ${bug.suggested_fix}\n\n`);
      }

      stream.markdown(`---\n\n`);
    }
  }

  return { metadata: { command: "bugs" } };
}

// ── /review command (the negotiation flow) ──

async function handleReview(
  request: vscode.ChatRequest,
  store: ProvenanceStore,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
): Promise<DeepTestResult> {
  const func = resolveFunction(request.prompt, store) ?? getFunctionAtCursor(store);

  if (!func) {
    stream.markdown("Place your cursor in a function, then use `@deeptest /review`\n");
    return { metadata: { command: "review" } };
  }

  const specs = store.getSpecsForFunction(func.id);
  const bugs = store.getBugsForFunction(func.id);
  const tests = store.getTestsForFunction(func.id);

  stream.markdown(`## 🔍 Behavior Review: \`${func.qualname}\`\n\n`);
  stream.markdown(`I've analyzed this function and have **${specs.length} behavioral claims** to discuss.\n\n`);

  // Present claims for review
  let claimNum = 0;
  for (const spec of specs) {
    claimNum++;
    const statusIcon = spec.status === "covered" ? "✅" : spec.status === "bug_associated" ? "⚠️" : "❓";
    const statusBadge = spec.status === "covered" ? "🤖 inferred → covered"
      : spec.status === "bug_associated" ? "⚠️ inferred → disputed"
      : "🤖 inferred";

    stream.markdown(`### Claim ${claimNum}: ${spec.direction.toUpperCase()}\n\n`);
    stream.markdown(`> ${spec.description ?? spec.expression}\n\n`);
    stream.markdown(`\`\`\`\n${spec.expression}\n\`\`\`\n\n`);
    stream.markdown(`Status: ${statusBadge}\n\n`);

    // If there's a bug associated, show the consequence
    if (spec.status === "bug_associated") {
      const relatedBugs = bugs.filter(b =>
        b.location.file === func.location.file &&
        b.location.line >= func.location.line &&
        b.location.line <= (func.location.end_line ?? func.location.line),
      );
      if (relatedBugs.length > 0) {
        const bug = relatedBugs[0];
        stream.markdown(
          `⚠️ **This claim may be violated.** A ${bug.triage?.severity ?? ""} bug was found at L${bug.location.line}:\n\n` +
          `> ${bug.description}\n\n` +
          `If you **accept** this as the intended contract, then the current code has a bug.\n` +
          `If you **reject** this claim, the behavior may be intentional.\n\n`,
        );
      }
    }

    // Show evidence
    const relevantTests = tests.filter(t =>
      t.function_links?.some(fl => fl.function_id === func.id),
    );
    if (relevantTests.length > 0) {
      const passing = relevantTests.filter(t => t.outcome === "passed").length;
      const failing = relevantTests.filter(t => t.outcome === "failed").length;
      stream.markdown(`📊 Evidence: ${passing} passing tests, ${failing} failing tests\n\n`);
    }

    stream.markdown(`---\n\n`);
  }

  // Prompt for action
  stream.markdown(
    `### What would you like to do?\n\n` +
    `You can tell me:\n` +
    `- "Accept claim 1" — confirms it as the intended contract\n` +
    `- "Reject claim 3" — marks it as wrong or irrelevant\n` +
    `- "This precondition is too strong" — I'll propose a weaker version\n` +
    `- "Show me an example for claim 2" — I'll generate a concrete input/output\n` +
    `- "Generate a test for the uncovered specs" — I'll write tests grounded in these specs\n\n`,
  );

  return {
    metadata: {
      command: "review",
      functionId: func.id,
      specIds: specs.map(s => s.id),
    },
  };
}

// ── Free-form handler (negotiation via LLM) ──

async function handleFreeform(
  request: vscode.ChatRequest,
  store: ProvenanceStore,
  stream: vscode.ChatResponseStream,
  chatContext: vscode.ChatContext,
  token: vscode.CancellationToken,
): Promise<DeepTestResult> {
  // Build context from the current function
  const func = getFunctionAtCursor(store);
  let contextBlock = "";

  if (func) {
    const specs = store.getSpecsForFunction(func.id);
    const bugs = store.getBugsForFunction(func.id);
    const tests = store.getTestsForFunction(func.id);

    contextBlock = `\n\nCurrent function: ${func.qualname} (${func.location.file}:${func.location.line})\n`;
    if (specs.length > 0) {
      contextBlock += `\nSpecifications:\n`;
      for (const s of specs) {
        contextBlock += `- ${s.direction}: ${s.expression} [${s.status}]\n`;
        if (s.description) { contextBlock += `  Description: ${s.description}\n`; }
      }
    }
    if (bugs.length > 0) {
      contextBlock += `\nBugs:\n`;
      for (const b of bugs) {
        contextBlock += `- [${b.triage?.severity}] ${b.bug_type} L${b.location.line}: ${b.description}\n`;
      }
    }
    if (tests.length > 0) {
      const p = tests.filter(t => t.outcome === "passed").length;
      const f = tests.filter(t => t.outcome === "failed").length;
      contextBlock += `\nTests: ${tests.length} total (${p} passing, ${f} failing)\n`;
    }
  }

  // Read source code at cursor if available
  const editor = vscode.window.activeTextEditor;
  let codeContext = "";
  if (editor && func) {
    const startLine = Math.max(0, func.location.line - 1);
    const endLine = Math.min(editor.document.lineCount, (func.location.end_line ?? func.location.line + 20));
    const range = new vscode.Range(startLine, 0, endLine, 0);
    codeContext = `\n\nSource code:\n\`\`\`\n${editor.document.getText(range)}\n\`\`\`\n`;
  }

  const systemPrompt = `You are DeepTest, an AI assistant that helps developers understand and refine specifications (pre/postconditions) for their code. You have access to:

1. Formal specifications (preconditions and postconditions) inferred from static analysis
2. Bug findings from automated bug detection with triage results
3. Test results showing which specs are covered

Your role is to help the developer through BEHAVIOR NEGOTIATION:
- Present specifications as plain-English behavioral claims
- When the developer accepts a claim, explain consequences (tests needed, bugs implied)
- When the developer disputes a claim, ask clarifying questions and show evidence
- When the developer asks for examples, generate concrete input/output pairs
- When asked to generate tests, propose test cases grounded in the spec

Always be concise. Use the spec data provided to ground your responses. Don't invent specs that aren't in the data — say what you know and what you don't.

${contextBlock}${codeContext}`;

  try {
    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.User(request.prompt),
    ];

    const chatResponse = await request.model.sendRequest(messages, {}, token);
    for await (const fragment of chatResponse.text) {
      stream.markdown(fragment);
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(`⚠️ ${err.message}\n`);
    } else {
      throw err;
    }
  }

  return {
    metadata: {
      command: "",
      functionId: func?.id,
    },
  };
}

// ── Helpers ──

function resolveFunction(prompt: string, store: ProvenanceStore): FunctionNode | undefined {
  if (!prompt.trim()) { return undefined; }
  const query = prompt.trim().toLowerCase();

  // Exact qualname match
  const exact = store.manifest.functions.find(
    f => f.qualname.toLowerCase() === query,
  );
  if (exact) { return exact; }

  // Partial match (short name)
  return store.manifest.functions.find(f => {
    const shortName = f.qualname.split("::").pop()?.toLowerCase() ?? "";
    return shortName === query || f.qualname.toLowerCase().includes(query);
  });
}

function getFunctionAtCursor(store: ProvenanceStore): FunctionNode | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return undefined; }
  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const line = editor.selection.active.line + 1;
  return store.getFunctionAtLine(filePath, line);
}
