import * as vscode from "vscode";
import { ProvenanceStore, FunctionNode, SpecificationNode, HazardNode, BugNode, TestNode } from "../provenance";

export class ProvenancePanel {
  public static readonly viewType = "deeptest.provenancePanel";
  private static instance: ProvenancePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly getStore: () => ProvenanceStore | undefined;
  private disposables: vscode.Disposable[] = [];
  private pinnedFunctionId: string | undefined;
  private lastFunctionId: string | undefined;
  private lastEditor: vscode.TextEditor | undefined;

  static show(
    extensionUri: vscode.Uri,
    getStore: () => ProvenanceStore | undefined,
  ): ProvenancePanel {
    if (ProvenancePanel.instance) {
      ProvenancePanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      ProvenancePanel.instance.refresh();
      return ProvenancePanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      ProvenancePanel.viewType,
      "DeepTest Provenance",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    ProvenancePanel.instance = new ProvenancePanel(panel, getStore);
    return ProvenancePanel.instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    getStore: () => ProvenanceStore | undefined,
  ) {
    this.panel = panel;
    this.getStore = getStore;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.command === "pin") {
          this.pinnedFunctionId = msg.functionId;
          this.refresh();
        } else if (msg.command === "unpin") {
          this.pinnedFunctionId = undefined;
          this.lastFunctionId = undefined;
          this.refresh();
        }
      },
      null,
      this.disposables,
    );

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => {
        if (this.pinnedFunctionId) { return; }
        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(() => this.refresh(), 150);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (this.pinnedFunctionId) { return; }
        this.lastFunctionId = undefined;
        this.refresh();
      }),
    );

    this.refresh();
  }

  refresh(): void {
    const store = this.getStore();
    const currentEditor = vscode.window.activeTextEditor;
    // When the webview panel itself has focus, activeTextEditor is undefined.
    // Keep showing the last known editor state instead of blanking.
    if (currentEditor) {
      this.lastEditor = currentEditor;
    }
    const editor = currentEditor ?? this.lastEditor;
    if (!store || !editor) {
      this.panel.webview.html = this.emptyHtml();
      return;
    }

    const filePath = vscode.workspace.asRelativePath(editor.document.uri);

    let func: FunctionNode | undefined;
    if (this.pinnedFunctionId) {
      func = store.getFunction(this.pinnedFunctionId);
    } else {
      const line = editor.selection.active.line + 1;
      func = store.getFunctionAtLine(filePath, line);
    }

    if (!func) {
      this.panel.webview.html = this.fileSummaryHtml(store, filePath);
      return;
    }

    if (func.id === this.lastFunctionId) { return; }
    this.lastFunctionId = func.id;

    const specs = store.getSpecsForFunction(func.id);
    const bugs = store.getBugsForFunction(func.id);
    const hazards = store.manifest.hazards.filter(h => h.function_id === func!.id);
    const tests = store.getTestsForFunction(func.id);

    this.panel.webview.html = this.buildHtml(filePath, func, specs, bugs, hazards, tests);
  }

  // ── HTML builders ──

  private emptyHtml(msg?: string): string {
    return `<!DOCTYPE html><html><head>${this.styles()}</head>
      <body><div class="empty">${msg ?? "Open a source file with DeepTest data"}</div></body></html>`;
  }

  private fileSummaryHtml(store: ProvenanceStore, filePath: string): string {
    const functions = store.getFunctionsInFile(filePath);
    if (functions.length === 0) {
      return this.emptyHtml(`No DeepTest data for <code>${this.esc(filePath)}</code>
        <br><br><span class="hint">Move cursor into a function with provenance data</span>`);
    }

    const totalSpecs = functions.reduce((n, f) => n + store.getSpecsForFunction(f.id).length, 0);
    const totalTests = functions.reduce((n, f) => n + store.getTestsForFunction(f.id).length, 0);
    const totalBugs = functions.reduce((n, f) => n + store.getBugsForFunction(f.id).length, 0);

    let html = `<div class="file-overview">
      <div class="file-header">${this.esc(filePath.split("/").pop() ?? filePath)}</div>
      <div class="file-stats">
        <span>📋 ${totalSpecs} specs</span>
        <span>🧪 ${totalTests} tests</span>
        ${totalBugs > 0 ? `<span class="bug-indicator">🐛 ${totalBugs} bugs</span>` : ""}
      </div>
      <div class="hint">Move cursor into a function to see its provenance</div>
      <div class="func-list">`;

    for (const f of functions) {
      const s = store.getFunctionSummary(f.id);
      if (s.specs === 0 && s.tests === 0 && s.bugs === 0) { continue; }
      html += `<div class="func-item">
        <span class="func-name">${this.esc(f.qualname)}</span>
        <span class="func-meta">L${f.location.line}${s.bugs > 0 ? ` · <span class="bug-indicator">🐛 ${s.bugs}</span>` : ""}</span>
      </div>`;
    }

    html += `</div></div>`;
    return `<!DOCTYPE html><html><head>${this.styles()}</head><body>${html}</body></html>`;
  }

  private buildHtml(
    filePath: string,
    func: FunctionNode,
    specs: SpecificationNode[],
    bugs: BugNode[],
    hazards: HazardNode[],
    tests: TestNode[],
  ): string {
    const isPinned = this.pinnedFunctionId === func.id;
    const pinBtn = isPinned
      ? `<button class="pin-btn pinned" onclick="post('unpin')">📌 Pinned</button>`
      : `<button class="pin-btn" onclick="post('pin', '${func.id}')">📌 Pin</button>`;

    let html = `
      <div class="header">
        <div class="header-top">
          <span class="fn-name">${this.esc(func.qualname)}</span>
          ${pinBtn}
        </div>
        <div class="header-meta">
          <span>${this.esc(filePath.split("/").pop() ?? "")}:${func.location.line}</span>
          <span>${isPinned ? "Pinned" : "Following cursor"}</span>
        </div>
      </div>`;

    // Bugs first (always open if present)
    if (bugs.length > 0) {
      html += this.section("🐛 Bugs", "bugs", `${bugs.length}`, true,
        bugs.map(b => this.renderBug(b)).join(""));
    }

    // Specs (always open)
    if (specs.length > 0) {
      const covered = specs.filter(s => s.status === "covered").length;
      html += this.section("📋 Specifications", "specs", `${covered}/${specs.length} covered`, true,
        specs.map(s => this.renderSpec(s)).join(""));
    }

    // Tests (collapsed)
    if (tests.length > 0) {
      const p = tests.filter(t => t.outcome === "passed").length;
      const f = tests.filter(t => t.outcome === "failed").length;
      const sorted = [...tests].sort((a, b) =>
        a.outcome === "failed" ? -1 : b.outcome === "failed" ? 1 : 0);
      html += this.section("🧪 Tests", "tests", `${p}✓ ${f}✗`, false,
        sorted.slice(0, 30).map(t => this.renderTest(t)).join("")
        + (tests.length > 30 ? `<div class="overflow">… ${tests.length - 30} more</div>` : ""));
    }

    // Hazards (collapsed)
    if (hazards.length > 0) {
      html += this.section("⚠️ Hazards", "hazards", `${hazards.length}`, false,
        hazards.map(h => this.renderHazard(h)).join(""));
    }

    if (specs.length === 0 && bugs.length === 0 && tests.length === 0 && hazards.length === 0) {
      html += `<div class="empty">No provenance data for this function</div>`;
    }

    const script = `<script>
      const vscode = acquireVsCodeApi();
      function post(cmd, fid) { vscode.postMessage({ command: cmd, functionId: fid }); }
      function toggle(id) {
        const el = document.getElementById(id);
        const arr = document.getElementById(id + '-arrow');
        el.classList.toggle('collapsed');
        arr.textContent = el.classList.contains('collapsed') ? '▸' : '▾';
      }
    </script>`;

    return `<!DOCTYPE html><html><head>${this.styles()}</head><body>${html}${script}</body></html>`;
  }

  private section(title: string, id: string, subtitle: string, open: boolean, content: string): string {
    return `<div class="section">
      <div class="section-header" onclick="toggle('${id}')">
        <span id="${id}-arrow" class="arrow">${open ? "▾" : "▸"}</span>
        <span class="section-title">${title}</span>
        <span class="section-sub">${subtitle}</span>
      </div>
      <div id="${id}" class="section-body${open ? "" : " collapsed"}">${content}</div>
    </div>`;
  }

  private renderSpec(s: SpecificationNode): string {
    const icon = s.status === "covered" ? "✅" : s.status === "bug_associated" ? "🐛" : "❓";
    const tip = s.status === "covered" ? "Covered by passing tests"
      : s.status === "bug_associated" ? "Bug found in this function" : "No linked tests";
    return `<div class="card spec-${s.status}">
      <div class="card-head">
        <span class="dir ${s.direction}">${s.direction}</span>
        <span title="${tip}">${icon}</span>
      </div>
      <code class="expr">${this.esc(s.expression)}</code>
      ${s.description ? `<div class="desc">${this.esc(s.description)}</div>` : ""}
    </div>`;
  }

  private renderBug(b: BugNode): string {
    const sc = (b.triage?.severity === "critical" || b.triage?.severity === "high") ? "hi" : b.triage?.severity === "medium" ? "med" : "lo";
    return `<div class="card bug-${sc}">
      <div class="card-head">
        <span class="bug-type">${this.esc(b.bug_type)}</span>
        <span class="line-ref">L${b.location.line}</span>
      </div>
      <div class="bug-desc">${this.esc(b.description)}</div>
      ${b.triage ? `<div class="pills">
        <span class="pill v-${b.triage.verdict}">${b.triage.verdict.replace(/_/g, " ")}</span>
        <span class="pill s-${b.triage.severity}">${b.triage.severity}</span>
        <span class="pill r-${b.triage.recommendation}">${b.triage.recommendation.replace(/_/g, " ")}</span>
      </div>` : ""}
      ${b.suggested_fix ? `<div class="fix">💡 ${this.esc(b.suggested_fix)}</div>` : ""}
    </div>`;
  }

  private renderHazard(h: HazardNode): string {
    return `<div class="card hazard">
      <div class="card-head">
        <span class="hz-kind">${this.esc(h.kind)}</span>
        <span class="line-ref">L${h.location.line}</span>
      </div>
      ${h.expression ? `<code class="expr">${this.esc(h.expression)}</code>` : ""}
      ${h.why ? `<div class="desc">${this.esc(h.why)}</div>` : ""}
    </div>`;
  }

  private renderTest(t: TestNode): string {
    const icon = t.outcome === "passed" ? "✅" : t.outcome === "failed" ? "❌" : "⏭️";
    const cls = (t.bug_ids?.length ?? 0) > 0 ? " bug-test" : "";
    return `<div class="trow ${t.outcome}${cls}">
      <span class="ticon">${icon}</span>
      <span class="tname">${this.esc(t.test_name)}</span>
    </div>`;
  }

  private esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  private styles(): string {
    return `<style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:var(--vscode-font-family,-apple-system,sans-serif);font-size:13px;
        color:var(--vscode-foreground);background:var(--vscode-editor-background)}

      .header{position:sticky;top:0;z-index:10;padding:10px 14px 8px;
        background:var(--vscode-sideBar-background,#252526);
        border-bottom:1px solid var(--vscode-panel-border,#3a3d41)}
      .header-top{display:flex;align-items:center;justify-content:space-between}
      .fn-name{font-family:var(--vscode-editor-font-family,monospace);font-weight:600;font-size:14px;
        color:var(--vscode-symbolIcon-functionForeground,#dcdcaa)}
      .pin-btn{background:none;border:1px solid var(--vscode-panel-border,#3a3d41);
        color:var(--vscode-foreground);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px}
      .pin-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
      .pin-btn.pinned{border-color:var(--vscode-focusBorder);color:var(--vscode-focusBorder)}
      .header-meta{display:flex;justify-content:space-between;margin-top:4px;
        font-size:11px;color:var(--vscode-descriptionForeground)}

      .section{border-bottom:1px solid var(--vscode-panel-border,#2a2d31)}
      .section-header{display:flex;align-items:center;gap:6px;padding:8px 14px;cursor:pointer;user-select:none}
      .section-header:hover{background:var(--vscode-list-hoverBackground)}
      .arrow{font-size:10px;width:12px;color:var(--vscode-descriptionForeground)}
      .section-title{font-weight:600;font-size:12px}
      .section-sub{font-size:11px;color:var(--vscode-descriptionForeground);margin-left:auto}
      .section-body{padding:4px 14px 10px}
      .section-body.collapsed{display:none}

      .card{padding:8px 10px;margin-bottom:6px;border-radius:5px;
        border-left:3px solid var(--vscode-panel-border);background:rgba(255,255,255,0.02)}
      .card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}

      .spec-covered{border-left-color:#3fb950}
      .spec-bug_associated{border-left-color:#f14c4c}
      .spec-untested{border-left-color:#6e7681}
      .dir{font-size:9px;font-weight:700;text-transform:uppercase;padding:1px 5px;border-radius:3px;
        background:rgba(255,255,255,0.08)}
      .dir.pre{color:#569cd6} .dir.post{color:#4ec9b0}
      .expr{display:block;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;
        color:var(--vscode-textPreformat-foreground,#d7ba7d);padding:3px 0;word-break:break-all;line-height:1.5}
      .desc{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.4;margin-top:2px}

      .bug-hi{border-left-color:#f14c4c;background:rgba(244,76,76,0.04)}
      .bug-med{border-left-color:#d29922;background:rgba(210,153,34,0.04)}
      .bug-lo{border-left-color:#6e7681}
      .bug-type{font-weight:600;font-size:12px}
      .line-ref{font-size:11px;color:var(--vscode-descriptionForeground)}
      .bug-desc{font-size:12px;line-height:1.4;margin-bottom:6px}
      .pills{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px}
      .pill{font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600}
      .v-true_positive,.v-likely_true_positive{background:#1a7f37;color:#fff}
      .v-uncertain,.v-likely_false_positive{background:#6e7681;color:#fff}
      .s-critical,.s-high{background:#da3633;color:#fff}
      .s-medium{background:#d29922;color:#fff}
      .s-low{background:#6e7681;color:#fff}
      .r-fix_immediately,.r-fix{background:#da3633;color:#fff}
      .r-investigate{background:#6e7681;color:#fff}
      .r-deprioritize,.r-dismiss{background:#484f58;color:#adb5bd}
      .fix{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.4}

      .hazard{border-left-color:#d7ba7d;background:rgba(215,186,125,0.04)}
      .hz-kind{font-weight:600;font-size:12px;color:#d7ba7d}

      .trow{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px}
      .trow.bug-test{color:#f14c4c}
      .ticon{font-size:11px;flex-shrink:0}
      .tname{font-family:var(--vscode-editor-font-family,monospace);font-size:12px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .overflow{font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;font-style:italic}

      .file-overview{padding:20px 14px}
      .file-header{font-weight:600;font-size:14px;margin-bottom:8px}
      .file-stats{display:flex;gap:12px;font-size:12px;margin-bottom:12px}
      .hint{font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:16px}
      .func-item{display:flex;justify-content:space-between;align-items:center;
        padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04)}
      .func-item .func-name{font-family:var(--vscode-editor-font-family,monospace);font-size:12px;
        color:var(--vscode-symbolIcon-functionForeground,#dcdcaa)}
      .func-meta{font-size:11px;color:var(--vscode-descriptionForeground)}
      .bug-indicator{color:#f14c4c}
      .empty{padding:40px 20px;text-align:center;color:var(--vscode-descriptionForeground)}
      .empty code{color:var(--vscode-textPreformat-foreground)}
    </style>`;
  }

  private dispose(): void {
    ProvenancePanel.instance = undefined;
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}
