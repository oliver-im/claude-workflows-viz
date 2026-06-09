import { Resvg } from "@resvg/resvg-js";

// Rasterize at 2× the SVG's intrinsic size so text stays crisp on hi-dpi
// displays. The diagram carries its own opaque background rect, so the PNG is
// never transparent.
const PNG_SCALE = 2;

/**
 * Rasterize a standalone SVG string to a PNG buffer with resvg — a native
 * renderer (Rust), no headless browser and no network. The SVG already encodes
 * its own width/height, so resvg renders at that intrinsic size scaled by
 * {@link PNG_SCALE}.
 */
export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: PNG_SCALE },
  });
  return resvg.render().asPng();
}
