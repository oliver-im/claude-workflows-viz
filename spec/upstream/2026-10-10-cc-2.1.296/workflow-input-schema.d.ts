export interface WorkflowInput {
  /**
   * Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().
   */
  script?: string;
  /**
   * Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script.
   */
  name?: string;
  /**
   * Ignored — set the workflow description in the script's `meta` block.
   */
  description?: string;
  /**
   * Ignored — set the workflow title in the script's `meta` block.
   */
  title?: string;
  /**
   * Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).
   */
  args?: {
    [k: string]: unknown;
  };
  /**
   * Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.
   */
  scriptPath?: string;
  /**
   * Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (TaskStop) before resuming.
   */
  resumeFromRunId?: string;
}

export interface WorkflowOutput {
  status: "async_launched" | "remote_launched";
  taskId: string;
  /**
   * TaskType of the registered background task — 'local_workflow' for in-process runs, 'remote_agent' when remote:true dispatches to CCR. Set on all new writes; absent only on transcripts written before this field existed.
   */
  taskType?: "local_workflow" | "remote_agent";
  /**
   * meta.name from the workflow script — same value as task_started.workflow_name. Set on all new writes; absent only on transcripts written before this field existed.
   */
  workflowName?: string;
  /**
   * Local workflow run identifier for resumeFromRunId. Absent for remote_launched (the CCR session URL is the resume handle there) and on transcripts written before this field existed.
   */
  runId?: string;
  summary?: string;
  /**
   * Directory where subagent transcripts are written during execution
   */
  transcriptDir?: string;
  /**
   * Path to the persisted workflow script for this invocation. Editable via Write/Edit; pass back as `scriptPath` to re-run without resending the script.
   */
  scriptPath?: string;
  /**
   * CCR session URL when status is remote_launched
   */
  sessionUrl?: string;
  /**
   * Non-blocking heads-up (e.g. local git state diverges from the pushed branch the cloud session will clone)
   */
  warning?: string;
  /**
   * Set if syntax check failed
   */
  error?: string;
}
