# Re-recording the contract fixtures

`tests/fixtures/recorded/*.json` is a desensitized capture of the published
`@deepseek-ai/dsh@0.2.1-alpha.1` Web surface. It is replayed through the real
`RunManager` by `tests/fixtures/fake-harness.mjs` when `FIXTURE_RECORDED` points
at the directory, so a wire change shows up as a failing local projection rather
than as a silent fixture drift.

## Procedure

1. Capture from a throwaway `DSH_HOME` so no user state is read or written:

   ```powershell
   npx --yes --package=@deepseek-ai/dsh@0.2.1-alpha.1 -- dsh web --no-open --port 0
   ```

   The capture script used for this revision is
   `.verify-scratch/test-foundation/capture.mjs` (workspace scratch, not shipped).
   It records: the launch-URL exchange, the unauthenticated controls,
   `workspace/create`, `session/create`, `session/list`, `session/projections`
   (known and unknown session), `session/prompt`, the settling `session/page`,
   two backwards windows with `maxMessages: 2`, three rejected pagination inputs,
   and `session/cancel`.

   No API key is needed: the keyless turn settles as
   `turn/end{reason:{kind:'error',error:{code:'MISSING_CREDENTIAL'}}}`, which is
   the exact case the replay test asserts.

2. Desensitize before writing anything into the repository
   (`.verify-scratch/test-foundation/desensitize.mjs`):

   - every UUID becomes `id-RECORDED-NNNN`; the session id and workspace id are
     remapped the same way;
   - the capture workspace path becomes `RECORDED_WORKSPACE`;
   - environment-derived long text (harness system prompt, skill catalogue,
     runtime/time context snapshots) is replaced by `<redacted: ...>` markers;
   - the launch token and the session cookie are never copied. Only the protocol
     facts survive: `tokenLength`, `exchangeHttp: 303`, `location: "./"`, and the
     `Set-Cookie` attribute list with the value replaced by `<cookie-value>` and
     the name by `RECORDED_COOKIE_NAME` (the real name is dynamic per launch).

3. The desensitizer refuses to write output that still contains the launch token,
   a non-placeholder `token=` value, the cookie name, `set-cookie`, the capture
   workspace path, the captured session/workspace ids, the npm cache path, or a
   user home directory. Any hit aborts the run.

4. Re-run `npx vitest run tests/contract` and update the assertions if the
   official wire genuinely changed; do not edit the recorded JSON by hand.

## Rules

- Never commit a launch URL, a session cookie, or a real credential.
- A recorded fragment is evidence, not a specification: keep the source pointers
  in `meta.json` (`deepseek-harness/...`) accurate, and re-read the official
  source before changing a boundary assertion.
- `session-page.json` is replayed verbatim and re-paginated by the fixture with
  the same cut rule as the official `paginate()`, so the fixture stays honest
  about `hasMore` and `beforeSeq`.
