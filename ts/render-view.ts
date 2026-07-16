import type * as acorn from "acorn";
import { analyzeBody } from "./analyze-body.js";
import type { Meta } from "./model.js";
import { placeTopology } from "./place-topology.js";
import { renderSvg } from "./render-svg.js";
import { renderTopology, renderTopologyGraph } from "./render-topology.js";

/** Render the analyzed workflow or topology view, falling back to phases. */
export function renderAnalyzedView(
  meta: Meta,
  program: acorn.Node,
  src: string,
  view: "workflow" | "topology",
): string {
  try {
    const topology = analyzeBody(program, src, meta.phases.map((p) => p.title));
    if (!topology.hasOrchestration) return renderSvg(meta);
    const layout = placeTopology(topology, meta);
    return view === "workflow" ? renderTopology(layout, meta) : renderTopologyGraph(layout);
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
    process.stderr.write(
      `claude-workflows-viz: warning: body analysis failed (${reason}); rendering meta phases only\n`,
    );
    return renderSvg(meta);
  }
}
