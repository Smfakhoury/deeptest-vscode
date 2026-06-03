import * as vscode from "vscode";
import { BugNode, HazardNode, ProvenanceStore, SpecificationNode } from "../provenance";

const SEVERITY_TO_DIAG: Record<string, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  high: vscode.DiagnosticSeverity.Error,
  medium: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
};

export class DiagnosticsProvider {
  private readonly collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("deeptest");
  }

  update(store: ProvenanceStore, workspaceRoot: string): void {
    this.collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const bug of store.manifest.bugs) {
      const uri = vscode.Uri.file(`${workspaceRoot}/${bug.location.file}`);
      const key = uri.toString();
      if (!byFile.has(key)) {
        byFile.set(key, []);
      }

      const severity = SEVERITY_TO_DIAG[bug.triage?.severity ?? "medium"] ?? vscode.DiagnosticSeverity.Warning;
      const range = new vscode.Range(
        bug.location.line - 1, 0,
        (bug.location.end_line ?? bug.location.line) - 1, Number.MAX_SAFE_INTEGER,
      );

      const diag = new vscode.Diagnostic(range, bug.description, severity);
      diag.source = "DeepTest";
      diag.code = bug.bug_type;

      const parts = [`[${bug.bug_type}] ${bug.description}`];
      if (bug.triage) {
        parts.push(`Verdict: ${bug.triage.verdict} · Severity: ${bug.triage.severity} · ${bug.triage.recommendation}`);
      }
      if (bug.suggested_fix) {
        parts.push(`Fix: ${bug.suggested_fix}`);
      }
      diag.message = parts.join("\n");

      byFile.get(key)!.push(diag);
    }

    for (const [uriStr, diags] of byFile) {
      this.collection.set(vscode.Uri.parse(uriStr), diags);
    }
  }

  dispose(): void {
    this.collection.dispose();
  }
}
