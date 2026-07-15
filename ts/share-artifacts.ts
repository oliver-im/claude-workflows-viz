import type * as acorn from "acorn";
import type { Meta } from "./model.js";
import { DEFAULT_PNG_SCALE, svgToPng } from "./render-png.js";
import { renderSvg } from "./render-svg.js";
import { renderAnalyzedView } from "./render-view.js";

export interface ShareArtifactInput {
  meta: Meta;
  program: acorn.Node;
  src: string;
  format: "svg" | "png";
  scale?: number;
  includeSource: boolean;
  view: "workflow" | "topology" | "phases";
}

export interface ShareArtifactOutput {
  image: {
    filename: "workflow.svg" | "workflow.png";
    data: string | Buffer;
  };
  source?: string;
}

/** Build the image and optional source artifact for `--share`. */
export function buildShareArtifacts(input: ShareArtifactInput): ShareArtifactOutput {
  const svg =
    input.view === "phases"
      ? renderSvg(input.meta)
      : renderAnalyzedView(input.meta, input.program, input.src, input.view);
  return {
    image:
      input.format === "svg"
        ? { filename: "workflow.svg", data: svg }
        : { filename: "workflow.png", data: svgToPng(svg, input.scale ?? DEFAULT_PNG_SCALE) },
    ...(input.includeSource ? { source: input.src } : {}),
  };
}
