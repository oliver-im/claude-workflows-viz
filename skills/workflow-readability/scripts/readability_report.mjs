#!/usr/bin/env node
// readability_report.mjs — turn a `claude-workflows-viz --format json` dump into
// a concrete worklist of what to humanize, and how.
//
// This is a heuristic ADVISORY pass (it's allowed to guess what looks cryptic);
// the binary itself never guesses. It only points; you decide the prose.
//
// Usage:
//   claude-workflows-viz wf.js --format json | node readability_report.mjs
//   node readability_report.mjs analysis.json
//
// Reads the analysis JSON from a file argument or stdin and prints markdown.

import { readFileSync } from "node:fs";

function readInput() {
  const arg = process.argv[2];
  if (arg) return readFileSync(arg, "utf8");
  return readFileSync(0, "utf8"); // fd 0 = stdin
}

/** A label is "code-shaped" (worth humanizing) when it reads like an identifier
 *  or a `verb:detail` / template tag rather than a phrase a reader would say.
 *  A template that expands to prose (`Draft the ${p} approach`) is fine; one with
 *  a non-parameter interpolation (`match:${i / 2}`) or a tag prefix is not. */
function isCodeShaped(label) {
  if (!label) return false;
  // An interpolation whose inner expression isn't a bare parameter — `${i / 2}`,
  // `${args.problem}` — reads as code no matter the surrounding words.
  for (const m of label.matchAll(/\$\{([^}]*)\}/g)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(m[1].trim())) return true;
  }
  // Otherwise judge the label as a reader sees it, each `${param}` standing in as a word.
  const shown = label.replace(/\$\{[^}]*\}/g, "X");
  if (/^[a-z][\w.-]*:/.test(shown)) return true; // action tag: draft:, review:, gen:
  if (/^[a-z][a-z0-9_]*$/.test(shown)) return true; // single lowercase token
  if (/^[a-z]/.test(shown) && !/\s/.test(shown)) return true; // lowercase, no spaces
  return false;
}

/** Multiplicity → short human note. */
function multNote(m) {
  if (!m) return "";
  if (m.kind === "exact") return ` ×${m.count}`;
  if (m.kind === "named") return ` ×${m.names.length} (${m.names.join(", ")})`;
  if (m.kind === "unknown") return ` ×N${m.hint ? ` (${m.hint})` : ""}`;
  return "";
}

const agents = []; // { phase, label, expandedLabels?, promptPreview?, mult, fanned }
const conditions = []; // { phase, kind, conditionLabel }

function walk(steps, fanned) {
  for (const s of steps ?? []) {
    switch (s.kind) {
      case "agent":
      case "workflow":
        agents.push({
          phase: s.phase,
          label: s.label,
          expandedLabels: s.expandedLabels,
          promptPreview: s.promptPreview,
          mult: s.multiplicity,
          fanned,
        });
        break;
      case "parallel":
        if (s.form === "branches") for (const arm of s.branches) walk(arm, fanned);
        else walk(s.body, true); // fan-out body repeats per item
        break;
      case "pipeline":
        for (const stage of s.stages) walk(stage, s.items?.kind === "named" || s.items?.kind === "exact");
        break;
      case "loop":
        conditions.push({ phase: s.phase, kind: `loop (${s.loopKind})`, conditionLabel: s.conditionLabel });
        walk(s.body, fanned);
        break;
      case "branch":
        conditions.push({ phase: s.phase, kind: "branch", conditionLabel: s.conditionLabel });
        walk(s.thenSteps, fanned);
        walk(s.elseSteps, fanned);
        break;
      case "control":
        // Control steps (continue/break/return) are structural, not author-authored
        // label strings — nothing to humanize here.
        break;
      default:
        break;
    }
  }
}

function fixHint(a) {
  if (a.fanned && /\$\{[^}]+\}/.test(a.label) && a.expandedLabels) {
    return "fan-out over named items — rewrite the label TEMPLATE keeping the `${param}` so each member stays distinct, e.g. `Draft the ${p} design`.";
  }
  if (/\$\{/.test(a.label)) {
    return "interpolation isn't a plain parameter, so it stays verbatim — replace the whole `label` with a static descriptive phrase.";
  }
  return "set or edit the agent's `label` to a short imperative phrase (it wins over the prompt).";
}

const json = JSON.parse(readInput());
const meta = json.meta ?? {};
const topo = json.topology ?? {};
walk(topo.steps, false);

const out = [];
out.push(`# Readability worklist — ${meta.name ?? json.source ?? "workflow"}`);
out.push("");
out.push(`Source: \`${json.source ?? "?"}\``);
out.push("");

const cryptic = agents.filter((a) => isCodeShaped(a.label));
out.push(`## Node labels to humanize (${cryptic.length})`);
if (cryptic.length === 0) out.push("- none — every node label already reads as a phrase.");
for (const a of cryptic) {
  const ex = a.expandedLabels ? ` → ${a.expandedLabels.slice(0, 3).join(", ")}${a.expandedLabels.length > 3 ? ", …" : ""}` : "";
  out.push(`- **\`${a.label}\`**${multNote(a.mult)}${ex}  _(phase: ${a.phase ?? "—"})_`);
  if (a.promptPreview) out.push(`  - prompt: ${a.promptPreview}`);
  out.push(`  - fix: ${fixHint(a)}`);
}
out.push("");

out.push(`## Conditions (verbatim — the renderer never paraphrases these) (${conditions.length})`);
if (conditions.length === 0) out.push("- none.");
for (const c of conditions) {
  // Flag a condition as terse only when it's a single short/cryptic token (`!b`, `ok`,
  // `x`) — a single real word (`!opponent`) or an expression (`confidence < 0.5`) is fine.
  const bare = c.conditionLabel.replace(/^!\s*/, "");
  const singleToken = /^[A-Za-z_$][\w.$]*$/.test(bare);
  const terse = (singleToken && bare.replace(/[^A-Za-z]/g, "").length <= 4) || c.conditionLabel.length <= 2;
  out.push(`- ${c.kind}: \`${c.conditionLabel}\`${terse ? "  ⚠ terse" : ""}  _(phase: ${c.phase ?? "—"})_`);
}
out.push("- To clarify a terse condition honestly, rename the variables/expressions in the CODE (e.g. `!b` → `!opponent`); the renderer shows the new source verbatim. Never paraphrase a condition into something the code doesn't say.");
out.push("");

const phases = meta.phases ?? [];
const thin = phases.filter((p) => !p.detail || p.detail.trim().length < 12);
out.push(`## Phases needing a detail (${thin.length}/${phases.length})`);
if (thin.length === 0) out.push("- none — every phase has a description.");
for (const p of thin) out.push(`- **${p.title}** — add a one-line \`detail\`.`);
out.push("");

const notes = topo.notes ?? [];
out.push(`## Analyzer notes (${notes.length})`);
if (notes.length === 0) out.push("- none — the body analyzed cleanly (no opaque/degraded steps).");
for (const n of notes) out.push(`- ${typeof n === "string" ? n : n.message}`);
out.push("");

process.stdout.write(out.join("\n") + "\n");
