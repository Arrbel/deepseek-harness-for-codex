---
name: deepseek-harness
description: Start the local DeepSeek Harness Web UI, provide a clickable session link, delegate a scoped coding task into the visible Web session, then independently review and verify the workspace changes. Use when the user asks Codex to use, show, control, or hand work to DeepSeek Harness.
---

# DeepSeek Harness

Use the `deepseek-harness` MCP tools to run DeepSeek Harness locally through its Web UI. The user must be able to watch the same session that Codex controls. Codex remains responsible for the task outcome and must inspect the changed files and run appropriate verification itself.

## Workflow

1. Call `doctor` before the first run in a task. Explain any failed prerequisite. `doctor` reports the MCP version, the supported Node engine range, the npm CLI it will use, and whether the pinned DSH runtime is already installed under the data directory. When `ready` is false, read `problems` (a list of unmet prerequisites with the fix for each) and report those lines instead of guessing. A DeepSeek API key may come from the MCP environment, the target workspace's uncommitted `.env` file, or the Harness Web Models settings.
   The first run for a given DSH version installs that exact runtime once (about one minute and ~486 MB on disk) before starting it; do not treat that one-off install as a hang. Later runs start in a few seconds without touching the network. If the install fails, report the npm error tail from the failure message instead of retrying blindly.
2. Inspect the target repository enough to write a concrete delegation prompt. Include the requested outcome, relevant repository instructions, scope limits, and acceptance checks. Do not include credentials.
3. Decide whether the attempt needs a new Harness session or should continue a completed one. Omit `sessionId` for independent work or a clean retry. Pass the earlier run's `sessionId` for a direct follow-up or correction that benefits from the existing conversation. Never reuse a running session or a session from another workspace.
4. Call `start_run` exactly once for that attempt with `openBrowser: false` and the chosen `sessionId`, if any. It starts or reuses `dsh web` and submits the task without opening a browser.
5. Show the returned `webUrl` as a clickable Markdown link so the user can open the live page when they choose. Treat it as a local login link because it contains a bearer token; do not copy it into the Harness task or other messages. State whether `sessionReused` is true. Do not call `open_service` unless the user explicitly asks Codex to open the page.
6. Call `wait_run` with a timeout of at most 30 seconds until the run is `succeeded`, `failed`, or `cancelled`. The browser and MCP observe the same session ID and history.
7. Treat the Harness response as a handoff report, not proof. Inspect the actual workspace diff, preserve unrelated user changes, and run the smallest checks that cover the change.
8. If review finds a concrete defect, choose whether to continue the completed session for context or start a clean correction session, state the defect and failed check precisely, and review the correction again.
9. Use `cancel_run` to cancel an unsafe or obsolete turn while leaving the Web page available. Use `stop_service` only when the local server is no longer needed.

## Reading the outcome

Judge a run by `status`, never by "is there an `error` string". Only `succeeded` means the work finished:

- `succeeded` — review the workspace diff and run the smallest checks that cover the change.
- `failed` — read `reason` and act accordingly: `auth` → the local login cookie could not be re-established; report it and check credentials (the client already retried once). `service-unreachable` → the local Harness process died; use `doctor` and `start_service` to rebuild it, then decide whether to retry the task. `protocol-drift` → the installed DSH version does not match this adapter: **do not retry**, report the quoted method and JSON path to the maintainer and suggest pinning `DSH_MCP_HARNESS_PACKAGE` to a known-good exact version. `turn-blocked` → the turn was rejected before running any step; try a fresh session or check the permission mode. `turn-truncated` → the answer hit the token limit; narrow the task and retry. `rpc:<code>` / `turn-aborted:*` / `turn-interrupted` / `turn-unknown:*` → report the exact `reason` rather than paraphrasing it.
- `cancelled` — the user asked for it; do not report it as a failure.
- `running` — do not wait forever: `wait_run` returns when it can, and a dead service now settles the run as `failed(service-unreachable)` instead of hanging. If it stays `running`, check `get_run` for `lastEventSeq`/`assistantText` progress before deciding.
- `stopUnconfirmed: true` on a service snapshot means the process could not be confirmed dead; verify ports and processes before assuming it stopped.

## Credentials and session reuse

- `token=[redacted]` in logs or error messages is **normal**: the login token never appears in observable output by design. Never paste the login URL into the Harness task text or any message other than showing it to the user.
- `auth` means the local login cookie was rejected and could not be re-established (the client already cleared the cookie and retried once). Ask the user to open `webUrl` again to sign in; do not retry the run blindly.
- `service-unreachable` means the local Harness process is gone. Run `doctor` to check the runtime package and data directory, then `start_service` to rebuild it before deciding whether to retry.
- If a run is refused because the session's workspace could not be proven (a message about `cwd` / "cannot prove this session belongs to this workspace"), drop `sessionId` and start a new session instead of forcing a reuse.
- The client refuses to exchange credentials with a URL that is not loopback (that failure is reported as `protocol-drift`), so a non-local Harness URL will never receive the token.

## Safety

- Harness Web starts as a loopback-only local child process and receives access to the requested workspace. Do not pass a broader directory than needed.
- The default permission mode is `workspace-write`. Do not switch to `danger-full-access` unless the user explicitly authorizes that broader access.
- On Windows, DSH `workspace-write` may leave persistent ACL marks on a workspace. Prefer an isolated worktree for write tasks when the folder is also used by other tools.
- Do not ask Harness to commit, push, publish, deploy, or contact external systems unless the user explicitly requested that action.
