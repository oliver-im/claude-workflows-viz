import type * as acorn from "acorn";
import { analyzeBody } from "./analyze-body.js";
import type { Meta } from "./model.js";
import { placeTopology } from "./place-topology.js";
import { renderSvg } from "./render-svg.js";
import { renderTopology, renderTopologyGraph } from "./render-topology.js";
import { summarizeTopology } from "./stats.js";
import { LIGHT, type Theme } from "./theme.js";

/** Render the analyzed workflow or topology view, falling back to phases. */
export function renderAnalyzedView(
  meta: Meta,
  program: acorn.Node,
  src: string,
  view: "workflow" | "topology",
  theme: Theme = LIGHT,
): string {
  try {
    const topology = analyzeBody(program, src, meta.phases.map((p) => p.title));
    if (!topology.hasOrchestration) return renderSvg(meta);
    if (view === "topology") {
      // No phase rows beside the graph here, so cards name unlabeled agents too.
      return renderTopologyGraph(placeTopology(topology, meta, { derivedLabels: true }), { theme, meta });
    }
    return renderTopology(placeTopology(topology, meta), meta, { theme, stats: summarizeTopology(topology, meta) });
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
    process.stderr.write(
      `claude-workflows-viz: warning: body analysis failed (${reason}); rendering meta phases only\n`,
    );
    return renderSvg(meta);
  }
}
