import * as vscode from "vscode";
import { ProvenanceStore } from "../provenance";

export class DecorationProvider {
  private readonly specDecoration: vscode.TextEditorDecorationType;
  private readonly hazardDecoration: vscode.TextEditorDecorationType;
  private readonly bugDecoration: vscode.TextEditorDecorationType;

  constructor() {
    this.specDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: undefined, // will use text-based gutter
      overviewRulerColor: "#569cd6",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      before: {
        contentText: "📋",
        margin: "0 4px 0 0",
      },
    });

    this.hazardDecoration = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: "#d7ba7d",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      before: {
        contentText: "⚠️",
        margin: "0 4px 0 0",
      },
    });

    this.bugDecoration = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: "#f14c4c",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      backgroundColor: "rgba(244, 76, 76, 0.08)",
      border: "1px solid rgba(244, 76, 76, 0.2)",
      before: {
        contentText: "🐛",
        margin: "0 4px 0 0",
      },
    });
  }

  update(editor: vscode.TextEditor, store: ProvenanceStore): void {
    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    if (!store.hasDataForFile(filePath)) {
      editor.setDecorations(this.specDecoration, []);
      editor.setDecorations(this.hazardDecoration, []);
      editor.setDecorations(this.bugDecoration, []);
      return;
    }

    // Spec decorations: at function start lines that have specs
    const specRanges: vscode.DecorationOptions[] = [];
    for (const func of store.getFunctionsInFile(filePath)) {
      const specs = store.getSpecsForFunction(func.id);
      if (specs.length > 0) {
        const line = func.location.line - 1;
        if (line >= 0 && line < editor.document.lineCount) {
          const preCount = specs.filter(s => s.direction === "pre").length;
          const postCount = specs.filter(s => s.direction === "post").length;
          specRanges.push({
            range: new vscode.Range(line, 0, line, 0),
            hoverMessage: `${preCount} precondition(s), ${postCount} postcondition(s)`,
          });
        }
      }
    }

    // Hazard decorations
    const hazardRanges: vscode.DecorationOptions[] = [];
    for (const h of store.getHazardsInFile(filePath)) {
      const line = h.location.line - 1;
      if (line >= 0 && line < editor.document.lineCount) {
        hazardRanges.push({
          range: new vscode.Range(line, 0, line, 0),
          hoverMessage: `⚠️ ${h.kind}: ${h.expression}`,
        });
      }
    }

    // Bug decorations
    const bugRanges: vscode.DecorationOptions[] = [];
    for (const b of store.getBugsInFile(filePath)) {
      const line = b.location.line - 1;
      if (line >= 0 && line < editor.document.lineCount) {
        const severity = b.triage?.severity ?? "unknown";
        bugRanges.push({
          range: new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
          hoverMessage: `🐛 [${severity}] ${b.bug_type}: ${b.description}`,
        });
      }
    }

    editor.setDecorations(this.specDecoration, specRanges);
    editor.setDecorations(this.hazardDecoration, hazardRanges);
    editor.setDecorations(this.bugDecoration, bugRanges);
  }

  dispose(): void {
    this.specDecoration.dispose();
    this.hazardDecoration.dispose();
    this.bugDecoration.dispose();
  }
}
