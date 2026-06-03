import * as vscode from "vscode";
import { ProvenanceStore, FunctionNode, SpecificationNode, HazardNode, BugNode } from "../provenance";

export class HoverProvider implements vscode.HoverProvider {
  constructor(private readonly getStore: () => ProvenanceStore | undefined) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const store = this.getStore();
    if (!store) { return undefined; }

    const filePath = vscode.workspace.asRelativePath(document.uri);
    const line = position.line + 1; // 1-based

    const parts: vscode.MarkdownString[] = [];

    // Check for bugs at this line
    const bugs = store.manifest.bugs.filter(
      b => b.location.file === filePath && b.location.line === line,
    );
    for (const bug of bugs) {
      parts.push(this.renderBug(bug));
    }

    // Check for hazards at this line
    const hazards = store.manifest.hazards.filter(
      h => h.location.file === filePath && h.location.line === line,
    );
    for (const hazard of hazards) {
      parts.push(this.renderHazard(hazard));
    }

    // Check if this is a function start line — show specs
    const func = store.getFunctionsInFile(filePath).find(f => f.location.line === line);
    if (func) {
      const specs = store.getSpecsForFunction(func.id);
      if (specs.length > 0) {
        parts.push(this.renderSpecs(func, specs));
      }
    }

    if (parts.length === 0) {
      // Check if we're inside a function range
      const containingFunc = store.getFunctionAtLine(filePath, line);
      if (containingFunc) {
        const specs = store.getSpecsForFunction(containingFunc.id);
        const bugs = store.getBugsForFunction(containingFunc.id);
        if (specs.length > 0 || bugs.length > 0) {
          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(`*In function* \`${containingFunc.qualname}\` — `);
          md.appendMarkdown(`${specs.length} spec(s), ${bugs.length} bug(s)\n\n`);
          parts.push(md);
        }
      }
    }

    if (parts.length === 0) { return undefined; }

    return new vscode.Hover(parts);
  }

  private renderBug(bug: BugNode): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### 🐛 Bug: ${bug.bug_type}\n\n`);
    md.appendMarkdown(`${bug.description}\n\n`);

    if (bug.triage) {
      const verdictIcon = bug.triage.verdict === "true_positive" ? "✅" : "⚠️";
      md.appendMarkdown(`| | |\n|---|---|\n`);
      md.appendMarkdown(`| **Verdict** | ${verdictIcon} ${bug.triage.verdict} |\n`);
      md.appendMarkdown(`| **Severity** | ${bug.triage.severity} |\n`);
      md.appendMarkdown(`| **Recommendation** | ${bug.triage.recommendation} |\n`);
      if (bug.triage.reproduced) {
        md.appendMarkdown(`| **Reproduced** | ${bug.triage.reproduced} |\n`);
      }
      if (bug.triage.publicly_triggerable) {
        md.appendMarkdown(`| **Publicly triggerable** | ${bug.triage.publicly_triggerable} |\n`);
      }
      md.appendMarkdown(`\n`);
    }

    if (bug.suggested_fix) {
      md.appendMarkdown(`**Suggested fix:** ${bug.suggested_fix}\n`);
    }

    return md;
  }

  private renderHazard(hazard: HazardNode): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### ⚠️ Hazard: ${hazard.kind}\n\n`);
    md.appendMarkdown(`\`${hazard.expression}\`\n\n`);
    if (hazard.why) {
      md.appendMarkdown(`${hazard.why}\n`);
    }
    return md;
  }

  private renderSpecs(func: FunctionNode, specs: SpecificationNode[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### 📋 Specifications for \`${func.qualname}\`\n\n`);

    const statusIcon: Record<string, string> = {
      covered: "✅",
      bug_associated: "🐛",
      untested: "❓",
    };

    for (const spec of specs) {
      const icon = statusIcon[spec.status] ?? "❓";
      const dir = spec.direction === "pre" ? "**PRE**" : "**POST**";
      md.appendMarkdown(`${icon} ${dir}: \`${spec.expression}\`\n\n`);
      if (spec.description) {
        md.appendMarkdown(`  *${spec.description}*\n\n`);
      }
    }

    return md;
  }
}
