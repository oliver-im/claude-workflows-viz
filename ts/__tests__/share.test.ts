import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ShareError, createShareGist } from "../share.js";

describe("createShareGist", () => {
  it("uploads workflow.svg as a secret gist by default", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "cwv-share-test-"));
    const calls: string[][] = [];
    try {
      const gistUrl = await createShareGist(
        { image: { filename: "workflow.svg", data: "<svg />" } },
        {
          tempRoot,
          runGh: async (args) => {
            calls.push(args);
            if (args[0] === "auth") return { stdout: "", stderr: "", code: 0 };
            expect(args.slice(0, 3)).toEqual(["gist", "create", "--public=false"]);
            expect(args).toHaveLength(4);
            expect(args[3]).toMatch(/[\\/]workflow\.svg$/);
            expect(readFileSync(args[3], "utf8")).toBe("<svg />");
            return {
              stdout: "https://gist.github.com/example/abc123\n",
              stderr: "",
              code: 0,
            };
          },
        },
      );

      expect(gistUrl).toBe("https://gist.github.com/example/abc123");
      expect(calls).toHaveLength(2);
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports an unauthenticated GitHub CLI", async () => {
    await expect(
      createShareGist(
        { image: { filename: "workflow.svg", data: "<svg />" } },
        { runGh: async () => ({ stdout: "", stderr: "denied", code: 1 }) },
      ),
    ).rejects.toThrowError(new ShareError("GitHub CLI is not logged in. Run 'gh auth login' first."));
  });

  it("reports when GitHub CLI is not installed", async () => {
    await expect(
      createShareGist(
        { image: { filename: "workflow.svg", data: "<svg />" } },
        { runGh: async () => ({ stdout: "", stderr: "", code: null, error: new Error("ENOENT") }) },
      ),
    ).rejects.toThrowError(/GitHub CLI \(gh\) is not installed/);
  });

  it("cleans up temporary artifacts when gist creation fails", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "cwv-share-test-"));
    try {
      await expect(
        createShareGist(
          { image: { filename: "workflow.svg", data: "<svg />" } },
          {
            tempRoot,
            runGh: async (args) =>
              args[0] === "auth"
                ? { stdout: "", stderr: "", code: 0 }
                : { stdout: "", stderr: "network failure", code: 1 },
          },
        ),
      ).rejects.toThrowError("Failed to create gist: network failure");
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves a non-github.com gist host in the returned URL", async () => {
    const gistUrl = await createShareGist(
      { image: { filename: "workflow.svg", data: "<svg />" } },
      {
        runGh: async (args) =>
          args[0] === "auth"
            ? { stdout: "", stderr: "", code: 0 }
            : { stdout: "https://ghe.example/gists/abc123\n", stderr: "", code: 0 },
      },
    );
    expect(gistUrl).toBe("https://ghe.example/gists/abc123");
  });

  it("reports a process error while creating the gist", async () => {
    await expect(
      createShareGist(
        { image: { filename: "workflow.svg", data: "<svg />" } },
        {
          runGh: async (args) =>
            args[0] === "auth"
              ? { stdout: "", stderr: "", code: 0 }
              : { stdout: "", stderr: "", code: null, error: new Error("broken pipe") },
        },
      ),
    ).rejects.toThrowError("Failed to create gist: broken pipe");
  });

  it("reports successful gh output that does not contain a URL", async () => {
    await expect(
      createShareGist(
        { image: { filename: "workflow.svg", data: "<svg />" } },
        {
          runGh: async (args) =>
            args[0] === "auth"
              ? { stdout: "", stderr: "", code: 0 }
              : { stdout: "created", stderr: "", code: 0 },
        },
      ),
    ).rejects.toThrowError("Failed to parse gist URL from gh output");
  });

  it("turns temporary-directory failures into a clean share error", async () => {
    const missingRoot = join(tmpdir(), "cwv-share-root-does-not-exist");
    await expect(
      createShareGist(
        { image: { filename: "workflow.svg", data: "<svg />" } },
        { tempRoot: missingRoot, runGh: async () => ({ stdout: "", stderr: "", code: 0 }) },
      ),
    ).rejects.toThrowError(/Failed to prepare share artifacts/);
  });

  it("adds workflow.js only when source inclusion is requested", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "cwv-share-test-"));
    try {
      const calls: string[][] = [];
      await createShareGist(
        { image: { filename: "workflow.png", data: Buffer.from("png") }, source: "export const meta = {};\n" },
        {
          tempRoot,
          runGh: async (args) => {
            calls.push(args);
            if (args[0] === "auth") return { stdout: "", stderr: "", code: 0 };
            expect(args).toHaveLength(5);
            expect(args[3]).toMatch(/[\\/]workflow\.png$/);
            expect(args[4]).toMatch(/[\\/]workflow\.js$/);
            expect(readFileSync(args[3])).toEqual(Buffer.from("png"));
            expect(readFileSync(args[4], "utf8")).toBe("export const meta = {};\n");
            return { stdout: "https://gist.github.com/example/source", stderr: "", code: 0 };
          },
        },
      );
      expect(calls).toHaveLength(2);
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
