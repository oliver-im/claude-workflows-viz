import { spawn } from "node:child_process";

/**
 * Open a file with the OS default handler (adapted from planview's
 * `ts/output.ts`). Used by `--open` to show the rendered SVG/PNG/HTML after it
 * is written.
 */
export function openBrowser(path: string): void {
  // Windows opens via `explorer.exe <path>`, NOT `cmd /C start`: `cmd` re-parses
  // metacharacters, so a path containing `&` (e.g. derived from a
  // maliciously-named workflow file) could be interpreted as a command.
  // explorer.exe receives the path as a literal CreateProcess argument, with no
  // shell in the loop. `open`/`xdg-open` on macOS/Linux are likewise shell-free.
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer.exe", [path]]
      : process.platform === "darwin"
        ? ["open", [path]]
        : ["xdg-open", [path]];
  // `spawn(...).unref()` lets us exit before the opener finishes, but a missing
  // binary fires an async `error` event — without this listener Node would
  // crash the parent with an unhandled exception even though our own work is
  // done. Swallow the failure so headless or stripped-down environments don't
  // fail an otherwise-successful render.
  const child = spawn(cmd as string, args as string[], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (err) => {
    process.stderr.write(
      `claude-workflows-viz: could not open '${path}' (${cmd}): ${err.message}\n`,
    );
  });
  child.unref();
}
