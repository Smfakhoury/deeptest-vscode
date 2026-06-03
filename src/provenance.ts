/**
 * DeepTest Provenance data model.
 *
 * Mirrors the provenance.schema.json contract: flat arrays of typed nodes
 * with cross-referencing string IDs.
 */

// ── Schema types ──

export interface Location {
  file: string;
  line: number;
  end_line?: number | null;
  column?: number | null;
  end_column?: number | null;
}

export interface FunctionNode {
  id: string;
  qualname: string;
  location: Location;
  signature?: string | null;
  summary?: string | null;
}

export interface SpecificationNode {
  id: string;
  function_id: string;
  direction: "pre" | "post";
  expression: string;
  description?: string | null;
  status: "covered" | "bug_associated" | "untested";
  evidence?: EvidenceEntry[];
}

export interface EvidenceEntry {
  type: "test" | "bug" | "hazard";
  ref_id: string;
  relationship?: "covers" | "violates" | "exposes";
  confidence?: "high" | "medium" | "low";
}

export interface HazardNode {
  id: string;
  function_id: string;
  kind: string;
  location: Location;
  expression: string;
  why?: string | null;
}

export interface FunctionLink {
  function_id: string;
  reason: "bug_location" | "coverage" | "name_match" | "same_file" | "generation_target";
  confidence?: "high" | "medium" | "low";
}

export interface TestNode {
  id: string;
  test_file: string;
  test_name: string;
  description?: string | null;
  outcome: "passed" | "failed" | "skipped";
  function_links?: FunctionLink[];
  bug_ids?: string[];
}

export interface TriageInfo {
  verdict: string;
  severity: string;
  recommendation: string;
  reproduced?: string;
  publicly_triggerable?: string;
}

export interface BugNode {
  id: string;
  bug_id: string;
  location: Location;
  bug_type: string;
  description: string;
  confidence: string;
  suggested_fix?: string | null;
  function_id?: string | null;
  test_id?: string | null;
  triage?: TriageInfo | null;
}

export interface CallEdge {
  caller_id: string;
  callee_id: string;
}

export interface ProvenanceManifest {
  version: string;
  generated_at: string;
  source_revision?: string | null;
  functions: FunctionNode[];
  specifications: SpecificationNode[];
  hazards: HazardNode[];
  tests: TestNode[];
  bugs: BugNode[];
  call_graph: CallEdge[];
  spec_documents?: SpecDocument[];
}

// ── Spec document types ──

export interface SpecDocument {
  path: string;
  title?: string | null;
  claims: SpecClaim[];
}

export interface SpecClaim {
  id: string;
  line: number;
  text: string;
  section?: string | null;
  function_ids?: string[];
  spec_ids?: string[];
  test_ids?: string[];
  bug_ids?: string[];
  status?: "covered" | "violated" | "untested" | "partial";
}

// ── Indexed provenance store ──

/** Line-level index for fast lookups by file:line. */
export interface LineEntry {
  functions: FunctionNode[];
  specifications: SpecificationNode[];
  hazards: HazardNode[];
  bugs: BugNode[];
}

export class ProvenanceStore {
  public readonly manifest: ProvenanceManifest;

  // Indexes
  private readonly byId: Map<string, FunctionNode | SpecificationNode | HazardNode | TestNode | BugNode> = new Map();
  private readonly byFileLine: Map<string, LineEntry> = new Map();
  private readonly funcById: Map<string, FunctionNode> = new Map();
  private readonly specsByFunc: Map<string, SpecificationNode[]> = new Map();
  private readonly testsByFunc: Map<string, TestNode[]> = new Map();
  private readonly bugsByFunc: Map<string, BugNode[]> = new Map();
  private readonly filesWithData: Set<string> = new Set();

  constructor(manifest: ProvenanceManifest) {
    this.manifest = manifest;
    this.buildIndexes();
  }

  private buildIndexes(): void {
    // Index functions
    for (const f of this.manifest.functions) {
      this.byId.set(f.id, f);
      this.funcById.set(f.id, f);
      this.filesWithData.add(f.location.file);
      this.indexAtLine(f.location.file, f.location.line, "functions", f);
    }

    // Index specifications (at function start line)
    for (const s of this.manifest.specifications) {
      this.byId.set(s.id, s);
      const func = this.funcById.get(s.function_id);
      if (func) {
        this.indexAtLine(func.location.file, func.location.line, "specifications", s);
        const arr = this.specsByFunc.get(s.function_id) ?? [];
        arr.push(s);
        this.specsByFunc.set(s.function_id, arr);
      }
    }

    // Index hazards
    for (const h of this.manifest.hazards) {
      this.byId.set(h.id, h);
      this.filesWithData.add(h.location.file);
      this.indexAtLine(h.location.file, h.location.line, "hazards", h);
    }

    // Index bugs
    for (const b of this.manifest.bugs) {
      this.byId.set(b.id, b);
      this.filesWithData.add(b.location.file);
      this.indexAtLine(b.location.file, b.location.line, "bugs", b);
      if (b.function_id) {
        const arr = this.bugsByFunc.get(b.function_id) ?? [];
        arr.push(b);
        this.bugsByFunc.set(b.function_id, arr);
      }
    }

    // Index tests by function
    for (const t of this.manifest.tests) {
      this.byId.set(t.id, t);
      for (const fl of t.function_links ?? []) {
        const arr = this.testsByFunc.get(fl.function_id) ?? [];
        arr.push(t);
        this.testsByFunc.set(fl.function_id, arr);
      }
    }
  }

  private indexAtLine(
    file: string,
    line: number,
    category: keyof LineEntry,
    node: any,
  ): void {
    const key = `${file}:${line}`;
    if (!this.byFileLine.has(key)) {
      this.byFileLine.set(key, {
        functions: [],
        specifications: [],
        hazards: [],
        bugs: [],
      });
    }
    const entry = this.byFileLine.get(key)!;
    (entry[category] as any[]).push(node);
  }

  // ── Query methods ──

  hasDataForFile(file: string): boolean {
    return this.filesWithData.has(file);
  }

  getAtLine(file: string, line: number): LineEntry | undefined {
    return this.byFileLine.get(`${file}:${line}`);
  }

  getFunctionsInFile(file: string): FunctionNode[] {
    return this.manifest.functions.filter(f => f.location.file === file);
  }

  getSpecsForFunction(functionId: string): SpecificationNode[] {
    return this.specsByFunc.get(functionId) ?? [];
  }

  getTestsForFunction(functionId: string): TestNode[] {
    return this.testsByFunc.get(functionId) ?? [];
  }

  getBugsForFunction(functionId: string): BugNode[] {
    return this.bugsByFunc.get(functionId) ?? [];
  }

  getBugsInFile(file: string): BugNode[] {
    return this.manifest.bugs.filter(b => b.location.file === file);
  }

  getHazardsInFile(file: string): HazardNode[] {
    return this.manifest.hazards.filter(h => h.location.file === file);
  }

  getFunction(id: string): FunctionNode | undefined {
    return this.funcById.get(id);
  }

  /** Find the function containing a given line. */
  getFunctionAtLine(file: string, line: number): FunctionNode | undefined {
    for (const f of this.manifest.functions) {
      if (f.location.file === file) {
        const start = f.location.line;
        const end = f.location.end_line ?? start;
        if (line >= start && line <= end) {
          return f;
        }
      }
    }
    return undefined;
  }

  /** Summary stats for a function. */
  getFunctionSummary(functionId: string): { specs: number; tests: number; bugs: number; hazards: number; passing: number; failing: number } {
    const specs = this.getSpecsForFunction(functionId).length;
    const tests = this.getTestsForFunction(functionId);
    const bugs = this.getBugsForFunction(functionId).length;
    const func = this.funcById.get(functionId);
    const hazards = func
      ? this.manifest.hazards.filter(
          h =>
            h.function_id === functionId ||
            (h.location.file === func.location.file &&
              h.location.line >= func.location.line &&
              h.location.line <= (func.location.end_line ?? func.location.line)),
        ).length
      : 0;
    const passing = tests.filter(t => t.outcome === "passed").length;
    const failing = tests.filter(t => t.outcome === "failed").length;
    return { specs, tests: tests.length, bugs, hazards, passing, failing };
  }
}
