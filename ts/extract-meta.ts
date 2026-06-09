import { readFileSync } from "node:fs";
import * as acorn from "acorn";
import type { ZodError } from "zod";
import { type Meta, metaSchema } from "./model.js";

/** Thrown for any failure to locate, read, or validate the `meta` block. */
export class MetaExtractionError extends Error {
  override name = "MetaExtractionError";
}

/**
 * Extract and validate the `meta` block from a dynamic-workflow file on disk.
 * The workflow is NEVER executed — not the module body, and not even the `meta`
 * expression itself (it is read straight off the AST).
 */
export function extractMeta(path: string): Meta {
  let src: string;
  try {
    src = readFileSync(path, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new MetaExtractionError(`cannot read '${path}': ${err.message}`);
  }
  return extractMetaFromSource(src);
}

/**
 * Pure core: workflow source string → validated `Meta`. Parses to an AST,
 * locates the `meta` initializer, reads it as a static data literal (no code
 * runs), then validates.
 */
export function extractMetaFromSource(src: string): Meta {
  let program: acorn.Node;
  try {
    program = acorn.parse(src, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch (e) {
    throw new MetaExtractionError(
      `could not parse workflow file as JavaScript: ${(e as Error).message}`,
    );
  }

  const init = findMetaInit(program);
  if (!init) {
    throw new MetaExtractionError(
      "no `export const meta = { ... }` declaration found",
    );
  }
  if (init.type !== "ObjectExpression") {
    throw new MetaExtractionError("`meta` is not an object literal");
  }

  let value: unknown;
  try {
    value = evalLiteralNode(init);
  } catch (e) {
    if (e instanceof MetaExtractionError) throw e;
    throw new MetaExtractionError(
      `could not read the meta literal: ${(e as Error).message}`,
    );
  }

  const parsed = metaSchema.safeParse(value);
  if (!parsed.success) {
    throw new MetaExtractionError(
      `meta failed validation: ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * Find the initializer of a top-level `meta` const — whether exported
 * (`export const meta = ...`) or bare (`const meta = ...`). Returns the init
 * AST node or null. The acorn AST is walked as `any`: precise node typing buys
 * nothing here and fights acorn's union types.
 */
function findMetaInit(program: acorn.Node): any {
  const body: any[] = (program as any).body ?? [];
  for (const node of body) {
    let decl: any = null;
    if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "VariableDeclaration"
    ) {
      decl = node.declaration;
    } else if (node.type === "VariableDeclaration") {
      decl = node;
    }
    if (!decl) continue;

    for (const d of decl.declarations) {
      if (d.id.type === "Identifier" && d.id.name === "meta" && d.init) {
        return d.init;
      }
    }
  }
  return null;
}

/**
 * Read an AST node that must be a pure data literal — object, array,
 * string/number/boolean/null, or a no-substitution template. Every executable
 * construct (call, identifier reference, function, getter/setter, method,
 * spread, computed key) is REJECTED, not evaluated. This is what makes "never
 * execute the workflow" hold for the `meta` expression too.
 */
function evalLiteralNode(node: any): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (prop.type !== "Property" || prop.kind !== "init" || prop.method) {
          throw new MetaExtractionError(
            "meta may only contain plain data (no getters, setters, or methods)",
          );
        }
        if (prop.computed) {
          throw new MetaExtractionError(
            "meta may not use computed property keys",
          );
        }
        obj[propKey(prop.key)] = evalLiteralNode(prop.value);
      }
      return obj;
    }
    case "ArrayExpression": {
      const arr: unknown[] = [];
      for (const el of node.elements) {
        if (el === null) {
          throw new MetaExtractionError("meta arrays may not contain holes");
        }
        if (el.type === "SpreadElement") {
          throw new MetaExtractionError("meta may not use spread elements");
        }
        arr.push(evalLiteralNode(el));
      }
      return arr;
    }
    case "Literal": {
      if (node.regex) {
        throw new MetaExtractionError(
          "meta may not contain regular expressions",
        );
      }
      return node.value;
    }
    case "TemplateLiteral": {
      if (node.expressions.length > 0) {
        throw new MetaExtractionError(
          "meta may not contain template expressions",
        );
      }
      return node.quasis[0].value.cooked;
    }
    case "UnaryExpression": {
      if (
        (node.operator === "-" || node.operator === "+") &&
        node.argument.type === "Literal" &&
        typeof node.argument.value === "number"
      ) {
        return node.operator === "-"
          ? -node.argument.value
          : node.argument.value;
      }
      throw new MetaExtractionError("meta contains an unsupported expression");
    }
    default:
      throw new MetaExtractionError(
        `meta contains a non-literal value (${node.type})`,
      );
  }
}

function propKey(key: any): string {
  if (key.type === "Identifier") return key.name;
  if (
    key.type === "Literal" &&
    (typeof key.value === "string" || typeof key.value === "number")
  ) {
    return String(key.value);
  }
  throw new MetaExtractionError("meta has an unsupported property key");
}

function formatIssues(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "unknown validation error";
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${issue.message} at ${path}`;
}
