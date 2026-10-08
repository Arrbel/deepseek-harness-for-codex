// Single synthetic DeepSeek Harness Web surface for the RunManager test suite.
//
// The wire is modelled on the official @deepseek-ai/dsh 0.2.1-alpha.1 remote
// surface. Every field that the local parser reads keeps its real name, nesting,
// and value domain; the corresponding official sources are listed in
// reports/impl-test-foundation.md. Scenario switches are environment variables so
// this stays one fixture process instead of a family of near-copies.
//
//   FIXTURE_TOKEN              one-time launch token in the ready URL (default fixture-token)
//   FIXTURE_AUTH               redirect (default) | plain | no-cookie | server-error
//   FIXTURE_COOKIE_NAME        cookie the Host sets (default dsh-auth)
//   FIXTURE_COOKIE_VALUE       cookie value the Host sets (default fixture)
//   FIXTURE_CWD                cwd reported by session/list (default: process cwd)
//   FIXTURE_LIST_OMIT_CWD      omit cwd from session/list items
//   FIXTURE_LIST_OMIT_RUNNING  omit running from session/list items
//   FIXTURE_LIST_OMIT_SESSION  omit the requested session from session/list items
//   FIXTURE_PAGE_LIMIT         cap the effective page window below maxMessages
//   FIXTURE_SINGLE_PAGE        always answer hasMore:false (the defective single-page server)
//   FIXTURE_FAIL_KIND          completed (default) | error | interrupted | aborted-user |
//                              aborted-parent | blocked | max-tokens
//   FIXTURE_CANCEL_KIND        aborted-user (default) | interrupted (the legacy fake closer)
//   FIXTURE_MESSAGES           assistant messages per turn (default 1)
//   FIXTURE_ASOF_SEQ           override the session/projections cursor
//   FIXTURE_PROJECTIONS        null -> session/projections always answers null
//   FIXTURE_DELAY_MS           delay before the turn settles (default 40)
//   FIXTURE_TURN_END           on (default) | skip (stop running without a terminal turn/end)
//   FIXTURE_UNAUTHORIZED       off (default) | once | after-prompt (reject /api with HTTP 401)
//   FIXTURE_EXIT_AFTER_MS      exit the fixture process this many ms after it starts serving
//   FIXTURE_MODE               serve (default) | crash-with-token | crash-silent
//   FIXTURE_RECORDED           directory holding recorded real-wire payloads (replay mode)
//   FIXTURE_RECORDED_SPLIT     projections calls answered from start.json (default 1)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const TOKEN = env.FIXTURE_TOKEN ?? "fixture-token";
const AUTH = env.FIXTURE_AUTH ?? "redirect";
const COOKIE = `${env.FIXTURE_COOKIE_NAME ?? "dsh-auth"}=${env.FIXTURE_COOKIE_VALUE ?? "fixture"}`;
const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);
const RECORDED = env.FIXTURE_RECORDED;
const RECORDED_SPLIT = Number.parseInt(env.FIXTURE_RECORDED_SPLIT ?? "1", 10);
const TURN_END = env.FIXTURE_TURN_END ?? "on";
const UNAUTHORIZED = env.FIXTURE_UNAUTHORIZED ?? "off";

function flag(name) {
  return env[name] === "1" || env[name] === "true";
}

if (env.FIXTURE_MODE === "crash-with-token") {
  // Writes a real-looking launch URL that does not match the readiness pattern,
  // then dies before readiness. The manager must redact the token from the error.
  process.stdout.write("npm error dsh web: failed to bind http://127.0.0.1:65535/?token=FIXTURE-SECRET-LAUNCH-TOKEN\n");
  process.exit(1);
}
if (env.FIXTURE_MODE === "crash-silent") process.exit(1);

// Observable evidence for assertions that must look at the wire rather than at
// what the product reports back.
const stats = { tokenExchanges: 0, unauthorizedGets: 0, unauthorizedApis: 0, prompts: 0, rpc: {}, turnEndReasons: [], lastAssistantMessage: null };
const recorded = RECORDED === undefined ? undefined : loadRecorded(RECORDED);

function loadRecorded(directory) {
  const read = (name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
  return {
    list: read("session-list.json"),
    projectionsStart: read("projections-start.json"),
    projectionsAfter: read("projections-after.json"),
    page: read("session-page.json"),
  };
}

let nextWorkspace = 1;
let nextSession = 1;
const workspaces = new Map();
const sessions = new Map();

function ok(rpcId, value) {
  return { type: "server-response", rpcId, result: { ok: true, value } };
}

function fail(rpcId, code, message) {
  return { type: "server-response", rpcId, result: { ok: false, error: { code, message } } };
}

function push(session, type, data) {
  // The wire wraps every durable event in a tagged history record; the client
  // filters on `record.type === 'event'`, so the tag is part of the contract.
  session.events.push({ type: "event", event: { type, seq: session.events.length, data } });
}

const FAIL_REASONS = {
  completed: () => ({ kind: "completed" }),
  error: () => ({
    kind: "error",
    error: {
      // Verbatim LlmFailure shape from the real keyless 0.2.1 capture.
      message: 'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment',
      code: "MISSING_CREDENTIAL",
    },
  }),
  interrupted: () => ({ kind: "interrupted" }),
  "aborted-user": () => ({ kind: "aborted", reason: { kind: "user" } }),
  "aborted-parent": () => ({ kind: "aborted", reason: { kind: "parent" } }),
  blocked: () => ({ kind: "blocked" }),
  "max-tokens": () => ({ kind: "max-tokens" }),
};

/**
 * Message-aligned backwards page, mirroring paginate() in
 * packages/api/session-controller/src/history.ts. `sourceEventSeqs` grouping is
 * not modelled because this fixture never emits a derived surface event.
 */
function paginate(events, beforeSeq, maxMessages, throughSeq) {
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
  let count = 0;
  let cut = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index].event;
    if (!MESSAGE_TYPES.has(event.type)) continue;
    count += 1;
    if (count >= maxMessages) {
      cut = event.seq;
      break;
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 };
}

function settle(session, task) {
  const turn = session.turn;
  const step = 1;
  for (let index = 0; index < session.messages; index += 1) {
    const data = {
      turn,
      step,
      message: {
        role: "assistant",
        content: [{ type: "text", text: index === 0 ? `completed:${task}` : `completed:${task}#${String(index + 1)}` }],
      },
      // Exact timed stream would carry real adapter frames; the product parser
      // never reads it, only the required field's presence is contractual.
      stream: [],
    };
    stats.lastAssistantMessage = data;
    push(session, "assistant/message", data);
  }
  push(session, "step/end", { turn, step });
  if (TURN_END !== "skip") {
    const reason = (FAIL_REASONS[session.failKind] ?? FAIL_REASONS.completed)();
    stats.turnEndReasons.push(reason);
    push(session, "turn/end", { turn, reason });
  }
  session.running = false;
  session.settled = true;
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET") {
    if (requestUrl.pathname === "/__fixture/stats") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(stats));
      return;
    }
    if (requestUrl.pathname === "/" && requestUrl.searchParams.get("token") === TOKEN) {
      if (AUTH === "plain") {
        stats.tokenExchanges += 1;
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>harness</html>");
        return;
      }
      if (AUTH === "server-error") {
        stats.tokenExchanges += 1;
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("boom");
        return;
      }
      stats.tokenExchanges += 1;
      const headers = { location: "./" };
      if (AUTH !== "no-cookie") headers["set-cookie"] = `${COOKIE}; Path=/; HttpOnly; SameSite=Strict`;
      response.writeHead(303, headers);
      response.end();
      return;
    }
    stats.unauthorizedGets += 1;
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("unauthorized");
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    // Credential-loss scenarios: `once` breaks exactly one call (the client must re-exchange the
    // launch URL and retry), `after-prompt` breaks every call from the first refresh on (the
    // retry also fails, so the run must settle as failed(auth) instead of hanging).
    if (UNAUTHORIZED !== "off" && (UNAUTHORIZED === "once" ? stats.unauthorizedApis === 0 : stats.prompts > 0)) {
      stats.unauthorizedApis += 1;
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized");
      return;
    }
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify(fail("unknown", "gateway/bad-request", "invalid JSON body")));
      return;
    }
    const { method, payload, rpcId } = message;
    const args = payload.args;
    stats.rpc[method] = (stats.rpc[method] ?? 0) + 1;

    if (request.headers.cookie !== COOKIE) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized");
      return;
    }

    let envelope;
    if (method === "workspace/create") {
      const workspaceId = `workspace-${nextWorkspace++}`;
      workspaces.set(workspaceId, args.request.path);
      envelope = ok(rpcId, { workspace: { workspaceId }, created: true });
    } else if (method === "session/create") {
      const sessionId = `session-${nextSession++}`;
      sessions.set(sessionId, {
        running: false, settled: false, turn: 0, messages: 1,
        failKind: env.FIXTURE_FAIL_KIND ?? "completed", events: [], task: "",
        cwd: workspaces.get(args.request.workspaceId),
      });
      envelope = ok(rpcId, { sessionId });
    } else if (method === "session/prompt") {
      const request_ = args.request;
      let session = sessions.get(request_.sessionId);
      if (session === undefined && recorded !== undefined) {
        // Replay mode serves a recorded session that this process never created;
        // accept the prompt so the recorded page/list/projection payloads stay
        // the only thing under test.
        session = {
          running: false, settled: false, turn: 0, messages: 0,
          failKind: "completed", events: [], task: "",
          cwd: env.FIXTURE_CWD ?? process.cwd(),
        };
        sessions.set(request_.sessionId, session);
      }
      if (session === undefined) {
        envelope = fail(rpcId, "session/not-found", `session "${request_.sessionId}" not found`);
      } else {
        session.running = true;
        session.settled = false;
        session.turn += 1;
        session.task = request_.content[0].text;
        stats.prompts += 1;
        session.messages = Number.parseInt(env.FIXTURE_MESSAGES ?? "1", 10);
        session.failKind = env.FIXTURE_FAIL_KIND ?? "completed";
        const turn = session.turn;
        push(session, "turn/start", { turn });
        push(session, "step/start", { turn, step: 1 });
        push(session, "user/message", {
          turn, step: 1, source: "user",
          message: { role: "user", content: [{ type: "text", text: session.task }] },
        });
        setTimeout(() => settle(session, session.task), Number.parseInt(env.FIXTURE_DELAY_MS ?? "40", 10));
        envelope = ok(rpcId, { accepted: true });
      }
    } else if (method === "session/list") {
      const items = [...sessions].map(([sessionId, session]) => {
        const item = { sessionId, updatedAt: Date.now(), agentAvailable: true, blank: session.events.length === 0 };
        if (!flag("FIXTURE_LIST_OMIT_RUNNING")) item.running = session.running;
        if (!flag("FIXTURE_LIST_OMIT_CWD")) item.cwd = env.FIXTURE_CWD ?? session.cwd;
        return item;
      });
      const filtered = flag("FIXTURE_LIST_OMIT_SESSION") ? [] : items;
      envelope = ok(rpcId, recorded === undefined ? { items: filtered } : { items: replayList(recorded.list.items) });
    } else if (method === "session/projections") {
      envelope = handleProjections(rpcId, args.request);
    } else if (method === "session/page") {
      envelope = handlePage(rpcId, args.request);
    } else if (method === "session/cancel") {
      const session = sessions.get(args.request.sessionId);
      if (session === undefined) {
        envelope = fail(rpcId, "session/not-found", `session "${args.request.sessionId}" not found`);
      } else {
        session.running = false;
        if (!session.settled) {
          // Official wire: a user cancellation closes the live turn as
          // turn/end{reason:{kind:'aborted',reason:{kind:'user'}}}, not as
          // the crash-recovery marker kind:'interrupted'.
          const reason = (env.FIXTURE_CANCEL_KIND ?? "aborted-user") === "interrupted"
            ? { kind: "interrupted" }
            : { kind: "aborted", reason: { kind: "user" } };
          stats.turnEndReasons.push(reason);
          push(session, "turn/end", { turn: session.turn, reason });
          session.settled = true;
        }
        envelope = ok(rpcId, { accepted: true });
      }
    } else {
      envelope = ok(rpcId, {});
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(envelope));
  });
});

function replayList(items) {
  // The recorded cwd belongs to the capture workspace; rewrite it so replay works
  // on any checkout while keeping every other recorded field verbatim.
  return items.map((item) => ({ ...item, cwd: env.FIXTURE_CWD ?? process.cwd() }));
}

let projectionCalls = 0;
function handleProjections(rpcId, request_) {
  projectionCalls += 1;
  if (env.FIXTURE_PROJECTIONS === "null") return ok(rpcId, null);
  if (recorded !== undefined) {
    const snapshot = projectionCalls <= RECORDED_SPLIT ? recorded.projectionsStart : recorded.projectionsAfter;
    return ok(rpcId, snapshot);
  }
  const session = sessions.get(request_.sessionId);
  if (session === undefined) return ok(rpcId, null);
  const asOfSeq = env.FIXTURE_ASOF_SEQ ?? String(session.events.length - 1);
  if (asOfSeq === "null") return ok(rpcId, null);
  return ok(rpcId, { asOfSeq: Number(asOfSeq), values: {} });
}

function handlePage(rpcId, request_) {
  const { throughSeq, beforeSeq, maxMessages } = request_;
  if (!Number.isSafeInteger(throughSeq) || throughSeq < -1) {
    return fail(rpcId, "gateway/bad-request", "throughSeq must be an integer greater than or equal to -1");
  }
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
    return fail(rpcId, "gateway/bad-request", "beforeSeq must be a non-negative safe integer");
  }
  if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages <= 0)) {
    return fail(rpcId, "gateway/bad-request", "maxMessages must be a positive safe integer");
  }
  const envLimit = env.FIXTURE_PAGE_LIMIT === undefined ? undefined : Number.parseInt(env.FIXTURE_PAGE_LIMIT, 10);
  const limit = Math.min(maxMessages ?? 50, envLimit ?? Number.POSITIVE_INFINITY);
  const source = recorded === undefined
    ? (sessions.get(request_.address.sessionId)?.events ?? [])
    : recorded.page.records;
  const page = paginate(source, beforeSeq, limit, throughSeq);
  const hasMore = flag("FIXTURE_SINGLE_PAGE") ? false : page.hasMore;
  return ok(rpcId, { records: page.events, hasMore });
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`dsh web: http://127.0.0.1:${address.port}/?token=${TOKEN}\n`);
  // Crash scenario: die while a turn is still open, so the run must converge as
  // failed(service-unreachable) instead of staying `running` forever.
  const exitAfter = Number.parseInt(env.FIXTURE_EXIT_AFTER_MS ?? "", 10);
  if (Number.isSafeInteger(exitAfter) && exitAfter > 0) setTimeout(() => process.exit(0), exitAfter);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
