import * as vscode from "vscode";
import { ProvenanceStore } from "../provenance";

/**
 * Provides CodeLens on spec/requirements documents that are linked
 * in provenance.json's spec_documents array.
 *
 * Each claim line gets a lens showing implementation and test status:
 *   "Implemented by 2 functions · 5 tests pass · 1 bug"
 */
export class SpecDocCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly getStore: () => ProvenanceStore | undefined) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const store = this.getStore();
    if (!store) { return []; }

    const specDocs = store.manifest.spec_documents;
    if (!specDocs || specDocs.length === 0) { return []; }

    const filePath = vscode.workspace.asRelativePath(document.uri);
    const doc = specDocs.find(d => d.path === filePath);
    if (!doc) { return []; }

    const lenses: vscode.CodeLens[] = [];

    for (const claim of doc.claims) {
      const line = claim.line - 1; // 0-based
      if (line < 0 || line >= document.lineCount) { continue; }

      const funcCount = claim.function_ids?.length ?? 0;
      const testIds = claim.test_ids ?? [];
      const bugIds = claim.bug_ids ?? [];

      // Count passing/failing tests
      let passing = 0;
      let failing = 0;
      for (const tid of testIds) {
        const test = store.manifest.tests.find(t => t.id === tid);
        if (test?.outcome === "passed") { passing++; }
        else if (test?.outcome === "failed") { failing++; }
      }

      const parts: string[] = [];

      // Status icon
      const statusIcon = claim.status === "covered" ? "✅"
        : claim.status === "violated" ? "🐛"
        : claim.status === "partial" ? "◐"
        : "❓";

      if (funcCount > 0) {
        parts.push(`${funcCount} function${funcCount > 1 ? "s" : ""}`);
      }
      if (testIds.length > 0) {
        parts.push(`${passing}✓ ${failing}✗`);
      }
      if (bugIds.length > 0) {
        parts.push(`${bugIds.length} bug${bugIds.length > 1 ? "s" : ""}`);
      }

      const title = parts.length > 0
        ? `${statusIcon} ${parts.join(" · ")}`
        : `${statusIcon} No linked code`;

      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title,
          command: "deeptest.showClaimDetail",
          arguments: [claim],
        }),
      );
    }

    return lenses;
  }
}
