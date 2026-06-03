import * as vscode from "vscode";
import { ProvenanceStore } from "../provenance";

export class ProvenanceCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly getStore: () => ProvenanceStore | undefined) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const store = this.getStore();
    if (!store) { return []; }

    const filePath = vscode.workspace.asRelativePath(document.uri);
    if (!store.hasDataForFile(filePath)) { return []; }

    const lenses: vscode.CodeLens[] = [];
    const functions = store.getFunctionsInFile(filePath);

    for (const func of functions) {
      const line = func.location.line - 1; // 0-based
      if (line < 0 || line >= document.lineCount) { continue; }

      const summary = store.getFunctionSummary(func.id);
      if (summary.specs === 0 && summary.tests === 0 && summary.bugs === 0 && summary.hazards === 0) {
        continue;
      }

      const parts: string[] = [];
      if (summary.specs > 0) {
        parts.push(`📋 ${summary.specs} spec${summary.specs > 1 ? "s" : ""}`);
      }
      if (summary.tests > 0) {
        const passInfo = summary.failing > 0
          ? ` (${summary.passing}✓ ${summary.failing}✗)`
          : "";
        parts.push(`🧪 ${summary.tests} test${summary.tests > 1 ? "s" : ""}${passInfo}`);
      }
      if (summary.bugs > 0) {
        parts.push(`🐛 ${summary.bugs} bug${summary.bugs > 1 ? "s" : ""}`);
      }
      if (summary.hazards > 0) {
        parts.push(`⚠️ ${summary.hazards} hazard${summary.hazards > 1 ? "s" : ""}`);
      }

      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: parts.join(" · "),
          command: "deeptest.showProvenance",
          arguments: [func.id],
        }),
      );
    }

    return lenses;
  }
}
