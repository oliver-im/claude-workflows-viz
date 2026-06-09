import { z } from "zod";

/**
 * One phase of a dynamic workflow, as declared in the `meta.phases` array.
 * `model` is a free-form string (e.g. "haiku" | "sonnet" | "opus", or a full
 * model id) — the renderer maps known names to colors and falls back otherwise.
 */
export const phaseSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  model: z.string().optional(),
});
export type Phase = z.infer<typeof phaseSchema>;

/**
 * The static, declarative `meta` block of a dynamic-workflow file. This is the
 * only part v1 renders — the imperative body is never read or executed.
 * Unknown keys are ignored; a missing `phases` normalizes to `[]`.
 */
export const metaSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  phases: z.array(phaseSchema).default([]),
});
export type Meta = z.infer<typeof metaSchema>;
