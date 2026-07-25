export interface AgentInput {
  /**
   * A short (3-5 word) description of the task
   */
  description: string;
  /**
   * The task for the agent to perform
   */
  prompt: string;
  /**
   * The type of specialized agent to use for this task
   */
  subagent_type?: string;
  /**
   * Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent. Ignored for subagent_type: "fork" — forks always inherit the parent model.
   */
  model?: "sonnet" | "opus" | "haiku" | "fable";
  /**
   * Agents run in the background by default; you will be notified when one completes. Set to false to run this agent synchronously when you need its result before continuing.
   */
  run_in_background?: boolean;
  /**
   * Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.
   */
  name?: string;
  /**
   * Deprecated; ignored. The session has a single implicit team.
   */
  team_name?: string;
  /**
   * Deprecated; ignored. Subagents inherit the parent session's permission mode; agent-definition frontmatter may override it.
   */
  mode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  /**
   * Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo. "remote" launches the agent in a remote cloud environment (always runs in background; availability is gated).
   */
  isolation?: "worktree" | "remote";
}

export type AgentOutput =
  | {
      agentId: string;
      agentType?: string;
      content: {
        type: "text";
        text: string;
        citations?: unknown[] | null;
      }[];
      resolvedModel?: string;
      modelsUsed?: string[];
      totalToolUseCount: number;
      totalDurationMs: number;
      totalTokens: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number | null;
        cache_read_input_tokens: number | null;
        server_tool_use: {
          web_search_requests: number;
          web_fetch_requests: number;
        } | null;
        service_tier: string | null;
        cache_creation: {
          ephemeral_1h_input_tokens: number;
          ephemeral_5m_input_tokens: number;
        } | null;
        inference_geo?: string | null;
        speed?: string | null;
        iterations?: unknown;
      };
      toolStats?: {
        readCount: number;
        searchCount: number;
        bashCount: number;
        editFileCount: number;
        linesAdded: number;
        linesRemoved: number;
        otherToolCount: number;
        frameCount?: number;
      };
      status: "completed";
      prompt: string;
      worktreePath?: string;
      worktreeBranch?: string;
    }
  | {
      status: "async_launched";
      isAsync?: true;
      /**
       * The ID of the async agent
       */
      agentId: string;
      /**
       * The description of the task
       */
      description: string;
      /**
       * Model in use at the backgrounding transition (a pre-background swap is reflected here)
       */
      resolvedModel?: string;
      /**
       * Ordered distinct models used before backgrounding (length > 1 means a mid-run swap)
       */
      modelsUsed?: string[];
      /**
       * The prompt for the agent
       */
      prompt: string;
      /**
       * Path to the output file for checking agent progress
       */
      outputFile: string;
      /**
       * Whether the calling agent has Read/Bash tools to check progress
       */
      canReadOutputFile?: boolean;
    }
  | {
      status: "remote_launched";
      /**
       * The ID of the remote agent task
       */
      taskId: string;
      /**
       * The URL of the cloud session
       */
      sessionUrl: string;
      /**
       * The description of the task
       */
      description: string;
      /**
       * The prompt for the agent
       */
      prompt: string;
      /**
       * Path to the output file for checking agent progress
       */
      outputFile: string;
    };
