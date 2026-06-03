import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ProvenanceManifest, ProvenanceStore } from "./provenance";
import { DiagnosticsProvider } from "./providers/diagnostics";
import { HoverProvider } from "./providers/hover";
import { ProvenanceCodeLensProvider } from "./providers/codelens";
import { DecorationProvider } from "./providers/decorations";
import { ProvenancePanel } from "./providers/panel";
import { SpecDocCodeLensProvider } from "./providers/specDocCodeLens";
import { registerDeepTestParticipant } from "./providers/chatParticipant";

let store: ProvenanceStore | undefined;
let diagnosticsProvider: DiagnosticsProvider;
let decorationProvider: DecorationProvider;
let codeLensProvider: ProvenanceCodeLensProvider;
let specDocLensProvider: SpecDocCodeLensProvider;
let extensionUri: vscode.Uri;

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getProvenancePath(): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) { return undefined; }
  const configPath = vscode.workspace
    .getConfiguration("deeptest")
    .get<string>("provenancePath", ".deeptest/report/provenance.json");
  return path.join(root, configPath);
}

function loadProvenance(): boolean {
  const filePath = getProvenancePath();
  if (!filePath || !fs.existsSync(filePath)) {
    store = undefined;
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const manifest: ProvenanceManifest = JSON.parse(raw);

    if (manifest.version !== "1.0") {
      vscode.window.showWarningMessage(
        `DeepTest: unsupported provenance version "${manifest.version}"`,
      );
      return false;
    }

    store = new ProvenanceStore(manifest);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(
      `DeepTest: failed to load provenance — ${err}`,
    );
    store = undefined;
    return false;
  }
}

function refreshAll(): void {
  const loaded = loadProvenance();
  const root = getWorkspaceRoot();

  if (loaded && store && root) {
    diagnosticsProvider.update(store, root);
    codeLensProvider.refresh();
    specDocLensProvider.refresh();

    // Update decorations on visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      decorationProvider.update(editor, store);
    }

    const { functions, specifications, hazards, tests, bugs } = store.manifest;
    vscode.window.showInformationMessage(
      `DeepTest: loaded ${functions.length} functions, ${specifications.length} specs, ` +
      `${tests.length} tests, ${bugs.length} bugs, ${hazards.length} hazards`,
    );

    // Auto-open the provenance panel
    ProvenancePanel.show(extensionUri, () => store);
  } else if (!loaded) {
    diagnosticsProvider.dispose();
    diagnosticsProvider = new DiagnosticsProvider();
  }
}

function showProvenanceForLine(functionIdOrUndefined?: string): void {
  if (!store) {
    vscode.window.showWarningMessage("DeepTest: no provenance loaded. Run 'DeepTest: Refresh Provenance'.");
    return;
  }

  let functionId = functionIdOrUndefined;

  // If no function ID passed, find function at cursor
  if (!functionId) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    const line = editor.selection.active.line + 1;
    const func = store.getFunctionAtLine(filePath, line);
    if (!func) {
      vscode.window.showInformationMessage("DeepTest: no function found at cursor position.");
      return;
    }
    functionId = func.id;
  }

  const func = store.getFunction(functionId);
  if (!func) { return; }

  const summary = store.getFunctionSummary(functionId);
  const specs = store.getSpecsForFunction(functionId);
  const tests = store.getTestsForFunction(functionId);
  const bugs = store.getBugsForFunction(functionId);

  // Build quick-pick items
  const items: vscode.QuickPickItem[] = [];

  items.push({ label: `$(symbol-function) ${func.qualname}`, kind: vscode.QuickPickItemKind.Separator });

  if (specs.length > 0) {
    items.push({ label: "Specifications", kind: vscode.QuickPickItemKind.Separator });
    for (const s of specs) {
      const icon = s.status === "covered" ? "$(pass)" : s.status === "bug_associated" ? "$(bug)" : "$(question)";
      items.push({
        label: `${icon} ${s.direction.toUpperCase()}: ${s.expression}`,
        detail: s.description ?? undefined,
        description: s.status,
      });
    }
  }

  if (bugs.length > 0) {
    items.push({ label: "Bugs", kind: vscode.QuickPickItemKind.Separator });
    for (const b of bugs) {
      items.push({
        label: `$(bug) [${b.triage?.severity ?? "?"}] ${b.bug_type}`,
        detail: b.description,
        description: b.triage?.verdict ?? "",
      });
    }
  }

  if (tests.length > 0) {
    items.push({ label: `Tests (${summary.passing}✓ ${summary.failing}✗)`, kind: vscode.QuickPickItemKind.Separator });
    for (const t of tests.slice(0, 20)) {
      const icon = t.outcome === "passed" ? "$(pass)" : t.outcome === "failed" ? "$(error)" : "$(dash)";
      items.push({
        label: `${icon} ${t.test_name}`,
        detail: t.description ?? undefined,
        description: t.outcome,
      });
    }
    if (tests.length > 20) {
      items.push({ label: `… and ${tests.length - 20} more tests`, description: "" });
    }
  }

  vscode.window.showQuickPick(items, {
    title: `Provenance: ${func.qualname}`,
    placeHolder: "Specs, tests, and bugs for this function",
  });
}

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  diagnosticsProvider = new DiagnosticsProvider();
  decorationProvider = new DecorationProvider();
  codeLensProvider = new ProvenanceCodeLensProvider(() => store);
  specDocLensProvider = new SpecDocCodeLensProvider(() => store);

  // Register providers
  context.subscriptions.push(
    diagnosticsProvider,
    decorationProvider,
    vscode.languages.registerHoverProvider({ scheme: "file" }, new HoverProvider(() => store)),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
    vscode.languages.registerCodeLensProvider({ scheme: "file", language: "markdown" }, specDocLensProvider),
    vscode.languages.registerCodeLensProvider({ scheme: "file", pattern: "**/*.txt" }, specDocLensProvider),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("deeptest.refresh", refreshAll),
    vscode.commands.registerCommand("deeptest.showProvenance", showProvenanceForLine),
    vscode.commands.registerCommand("deeptest.openPanel", () => {
      ProvenancePanel.show(extensionUri, () => store);
    }),
    vscode.commands.registerCommand("deeptest.showClaimDetail", (claim: any) => {
      if (!store || !claim) { return; }

      const items: vscode.QuickPickItem[] = [];
      items.push({ label: `$(book) ${claim.text}`, kind: vscode.QuickPickItemKind.Separator });

      if (claim.section) {
        items.push({ label: `Section: ${claim.section}`, description: claim.status ?? "" });
      }

      // Show linked functions
      for (const fid of claim.function_ids ?? []) {
        const func = store.getFunction(fid);
        if (func) {
          items.push({
            label: `$(symbol-function) ${func.qualname}`,
            detail: `${func.location.file}:${func.location.line}`,
            description: "implementing function",
          });
        }
      }

      // Show linked bugs
      for (const bid of claim.bug_ids ?? []) {
        const bug = store.manifest.bugs.find(b => b.id === bid);
        if (bug) {
          items.push({
            label: `$(bug) [${bug.triage?.severity ?? "?"}] ${bug.bug_type}`,
            detail: bug.description,
            description: bug.triage?.verdict ?? "",
          });
        }
      }

      // Show linked tests
      for (const tid of claim.test_ids ?? []) {
        const test = store.manifest.tests.find(t => t.id === tid);
        if (test) {
          const icon = test.outcome === "passed" ? "$(pass)" : "$(error)";
          items.push({
            label: `${icon} ${test.test_name}`,
            description: test.outcome,
          });
        }
      }

      vscode.window.showQuickPick(items, {
        title: `Claim: ${claim.text.substring(0, 60)}…`,
        placeHolder: "Linked functions, tests, and bugs",
      });
    }),
  );

  // Auto-update decorations when editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && store) {
        decorationProvider.update(editor, store);
      }
    }),
  );

  // Watch for provenance.json changes
  const provPath = getProvenancePath();
  if (provPath) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.workspace.workspaceFolders![0],
        ".deeptest/report/provenance.json",
      ),
    );
    watcher.onDidChange(() => refreshAll());
    watcher.onDidCreate(() => refreshAll());
    context.subscriptions.push(watcher);
  }

  // Register chat participant
  registerDeepTestParticipant(context, () => store);

  // Initial load
  refreshAll();
}

export function deactivate(): void {
  store = undefined;
}
