// Opening the Harness page in the user's default browser — the single browser side effect.

import { spawn } from "node:child_process";

/** Opens `url` in the platform's default browser. Rejects when the opener fails. */
export async function openInDefaultBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${String(code)}`)));
  });
}
