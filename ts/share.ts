import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ShareArtifacts {
  image: {
    filename: "workflow.svg" | "workflow.png";
    data: string | Buffer;
  };
  source?: string;
}

interface GhResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: Error;
}

export interface ShareOptions {
  /** Test seam for the external `gh` process. */
  runGh?: (args: string[]) => Promise<GhResult>;
  /** Test seam that keeps temporary files under a caller-controlled root. */
  tempRoot?: string;
}

export class ShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareError";
  }
}

function runGh(args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (error) => resolve({ stdout, stderr, code: null, error }));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function parseGistUrl(stdout: string): string | undefined {
  // GitHub Enterprise may return a host other than gist.github.com.
  const match = stdout.match(/https?:\/\/[^\s]+/);
  return match?.[0]?.replace(/[),.;]+$/, "");
}

/** Upload the rendered image and optional workflow source as a secret gist. */
export async function createShareGist(
  artifacts: ShareArtifacts,
  options: ShareOptions = {},
): Promise<string> {
  const gh = options.runGh ?? runGh;
  const auth = await gh(["auth", "status"]);
  if (auth.error) {
    throw new ShareError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
  }
  if (auth.code !== 0) {
    throw new ShareError("GitHub CLI is not logged in. Run 'gh auth login' first.");
  }

  let shareDir: string;
  try {
    shareDir = mkdtempSync(join(options.tempRoot ?? tmpdir(), "claude-workflows-viz-share-"));
  } catch (error) {
    throw new ShareError(`Failed to prepare share artifacts: ${error instanceof Error ? error.message : String(error)}`);
  }
  const imagePath = join(shareDir, artifacts.image.filename);
  const source = artifacts.source;

  try {
    writeFileSync(imagePath, artifacts.image.data);
    const paths = [imagePath];
    if (source !== undefined) {
      const sourcePath = join(shareDir, "workflow.js");
      writeFileSync(sourcePath, source);
      paths.push(sourcePath);
    }
    const result = await gh(["gist", "create", "--public=false", ...paths]);
    if (result.error) {
      throw new ShareError(`Failed to create gist: ${result.error.message}`);
    }
    if (result.code !== 0) {
      const reason = result.stderr.trim() || "Unknown error";
      throw new ShareError(`Failed to create gist: ${reason}`);
    }

    const gistUrl = parseGistUrl(result.stdout);
    if (!gistUrl) {
      throw new ShareError("Failed to parse gist URL from gh output");
    }
    return gistUrl;
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError(`Failed to prepare share artifacts: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
  }
}
