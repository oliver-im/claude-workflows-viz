import type { Meta } from "./model.js";
import type { Multiplicity, Step, Topology } from "./topology.js";

/**
 * The header's at-a-glance strip: how big a workflow is, counted from the body's
 * literals only. Every number is a fact about the source — call SITES, not
 * spawned agents (a call inside a loop or fan-out counts once), and a fan-out
 * width is literal or `×N`, never estimated.
 */
export interface WorkflowStats {
  phases: number;
  agentCalls: number;
  /** Widest parallel fan-out or pipeline: "×4", or "×N" when any width is unknown. */
  fanout?: string;
  loops: number;
  decisions: number;
  subWorkflows: number;
}

export function summarizeTopology(topology: Topology, meta: Meta): WorkflowStats {
  const stats: WorkflowStats = {
    phases: meta.phases.length,
    agentCalls: 0,
    loops: 0,
    decisions: 0,
    subWorkflows: 0,
  };
  let widest = 0;
  let unknown = false;
  const width = (m: Multiplicity): void => {
    if (m.kind === "unknown") unknown = true;
    else if (m.kind === "exact") widest = Math.max(widest, m.count);
    else if (m.kind === "named") widest = Math.max(widest, m.names.length);
  };
  const visit = (steps: Step[]): void => {
    for (const step of steps) {
      switch (step.kind) {
        case "agent":
          stats.agentCalls++;
          break;
        case "workflow":
          stats.subWorkflows++;
          break;
        case "parallel":
          if (step.form === "fanout") {
            width(step.multiplicity);
            visit(step.body);
          } else {
            widest = Math.max(widest, step.branches.length);
            step.branches.forEach(visit);
          }
          break;
        case "pipeline":
          width(step.items);
          step.stages.forEach(visit);
          break;
        case "branch":
          stats.decisions++;
          visit(step.thenSteps);
          visit(step.elseSteps);
          break;
        case "loop":
          stats.loops++;
          visit(step.body);
          break;
        default:
          break;
      }
    }
  };
  visit(topology.steps);
  if (unknown) stats.fanout = "×N";
  else if (widest > 1) stats.fanout = `×${widest}`;
  return stats;
}

/** The strip's chips, in reading order; zero counts are left out. */
export function statChips(stats: WorkflowStats): string[] {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return [
    ...(stats.phases > 0 ? [plural(stats.phases, "phase", "phases")] : []),
    plural(stats.agentCalls, "agent() call", "agent() calls"),
    ...(stats.fanout !== undefined ? [`fan-out ${stats.fanout}`] : []),
    ...(stats.loops > 0 ? [plural(stats.loops, "loop", "loops")] : []),
    ...(stats.decisions > 0 ? [plural(stats.decisions, "decision", "decisions")] : []),
    ...(stats.subWorkflows > 0 ? [plural(stats.subWorkflows, "sub-workflow", "sub-workflows")] : []),
  ];
}
