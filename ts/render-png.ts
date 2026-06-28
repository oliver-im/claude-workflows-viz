import { losslessCompressPngSync, pngQuantizeSync } from "@napi-rs/image";
import { Resvg } from "@resvg/resvg-js";

/**
 * Default rasterization scale: 2× the SVG's intrinsic size so text stays crisp
 * on hi-dpi displays. Overridable via the CLI `--scale` (PNG only).
 */
export const DEFAULT_PNG_SCALE = 2;

/**
 * Rasterize a standalone SVG string to an optimized PNG buffer.
 *
 * Pipeline (all native — no headless browser, no network):
 *   1. resvg renders the SVG at `scale`× its intrinsic size.
 *   2. The raw RGBA PNG is palette-quantized — a workflow diagram has well under
 *      256 distinct colors, so reducing to a palette is *visually* lossless while
 *      cutting the file ~3-4× (a ~200KB render lands near ~50KB).
 *   3. The quantized PNG is losslessly re-packed (oxipng) to squeeze the last
 *      bytes and strip non-critical chunks.
 *
 * Quantization is robust-by-fallback: if it ever fails (e.g. a pathological
 * high-color render), step 2 is skipped and the raw render is still losslessly
 * optimized — the tool always emits a PNG. The SVG carries its own opaque
 * background rect, so the PNG is never transparent.
 *
 * Settings are fixed (`speed: 1` = best quality; we rasterize one image, not a
 * stream), which keeps the output deterministic — re-running `regen-examples`
 * produces byte-stable renders and clean diffs.
 */
export function svgToPng(svg: string, scale: number = DEFAULT_PNG_SCALE): Buffer {
  const resvg = new Resvg(svg, { fitTo: { mode: "zoom", value: scale } });
  const raw = resvg.render().asPng();

  let quantized: Buffer;
  try {
    quantized = pngQuantizeSync(raw, { maxQuality: 100, speed: 1 });
  } catch {
    quantized = raw;
  }
  return losslessCompressPngSync(quantized, { strip: true });
}
