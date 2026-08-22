// Finds out what a completion endpoint actually does with a fill-in-the-middle
// request, which is not something a gateway documents and not something the
// extension can tell from a plausible-looking answer. Four questions:
//
//   1. Does `suffix` reach the model, or does the gateway drop the field?
//   2. Do the model's own FIM sentinel tokens work when the prompt is built here
//      instead, which is what Zed does and what does not need gateway support?
//   3. Does the endpoint honour `stream: true`?
//   4. How long does each shape take to the first byte and to the end?
//
// Timing a shape once is not a measurement. The first request of a run pays for
// DNS and the TLS handshake, and a shared gateway varies from one second to the
// next, so every shape is sent after a warm-up and several times over, and the
// median is what gets compared.
//
// Usage:
//   $env:DEXT_PROBE_KEY = "sk-..."
//   node scripts/probeCompletionApi.mjs --endpoint https://host/v1 --model my-model --repeat 5

import diagnostics from "node:diagnostics_channel";

// Whether a pause cost a new connection is a fact Node will state outright, and
// timing cannot: a gateway whose baseline drifts by a factor of two between runs
// buries a one-second handshake in noise. This counts the handshakes instead.
let connections = 0;
try {
  diagnostics.subscribe("undici:client:connected", () => { connections += 1; });
} catch {
  // An older runtime without the channel. The sweep still reports timings.
}
const connectionsMade = () => connections;

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const next = process.argv[index + 1];
  // A flag followed by another flag, or by nothing, is a switch rather than a
  // setting. Stepping by two instead would let `--quality` swallow `--models`.
  const isSwitch = next === undefined || next.startsWith("--");
  args.set(token.slice(2), isSwitch ? true : next);
  if (!isSwitch) index += 1;
}

/** A switch carries `true`, which is never a usable value for these. */
const text = (name, fallback = "") => {
  const value = args.get(name);
  return typeof value === "string" ? value : fallback;
};

const endpoint = text("endpoint").replace(/\/+$/, "");
const model = text("model");
const key = text("key") || process.env.DEXT_PROBE_KEY || "";
const repeat = Math.max(1, Number(text("repeat", "3")));
// Pauses to try before a request, in seconds. Sweeping them finds the point at
// which an idle connection stops being reused, and where that point falls says
// who closed it: Node's pool gives up on an idle socket after about four
// seconds by default, so a cliff around there is the client's doing and can be
// configured away, while a cliff sooner or a slow request at every pause is the
// gateway's and cannot.
// Several models to race against each other, rather than one to characterise.
// Which request shape to race them in. Plenty of models are reachable only
// through one of the two, and a model that refuses `/completions` may still fill
// in the middle perfectly well when asked as a chat.
const shape = text("shape") === "chat" ? "chat" : "fim";

// `id` uses the shape above; `id@chat` or `id@fim` overrides it for that entry
// alone. Racing a candidate against the incumbent means racing two different
// shapes, and comparing them across separate runs of this script would be
// comparing two moments of a gateway that drifts.
const modelList = text("models")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((entry) => {
    const [id, override] = entry.split("@");
    return { entry, id, shape: override === "chat" || override === "fim" ? override : shape };
  });

const idleSweep = text("idle", "3,6,12,30")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0);

if (!endpoint || (!model && !modelList.length)) {
  console.error("Need --endpoint <base url> and either --model <id> or --models <id,id,id>.");
  console.error("The key comes from --key or DEXT_PROBE_KEY.");
  process.exit(2);
}

// The completion is only answerable from the text after the cursor: ZEBRA
// appears nowhere before it. A model that names the constant was shown the
// suffix, and one that invents a different name was not.
const MARKER = "ZEBRA";
const PREFIX = `# Returns the constant defined at the bottom of this file.
def compute():
    return MAGIC_`;
const SUFFIX = `

MAGIC_CONSTANT_${MARKER} = 42
`;

/** The sentinels each family was trained on. Zed calls this `prompt_format`,
 * and it is the difference between a base model filling a hole and a model
 * being handed a truncated file and guessing. */
const FORMATS = {
  deepseek: (prefix, suffix) => `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
  qwen: (prefix, suffix) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
  codestral: (prefix, suffix) => `[SUFFIX]${suffix}[PREFIX]${prefix}`
};

const headers = {
  "Content-Type": "application/json",
  ...(key ? { Authorization: `Bearer ${key}` } : {})
};

async function send(label, path, body) {
  const started = Date.now();
  let firstByteMs;
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return { label, error: `HTTP ${response.status} ${detail}` };
    }
    // Reading the raw bytes rather than .json() is the only way to see whether
    // anything arrived before the end.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === undefined) firstByteMs = Date.now() - started;
      chunks += 1;
      raw += decoder.decode(value, { stream: true });
    }
    const totalMs = Date.now() - started;
    const eventStream = raw.startsWith("data:") || raw.includes("\ndata:");
    return {
      label,
      text: eventStream ? fromEvents(raw) : fromJson(raw),
      streamed: eventStream && chunks > 1,
      chunks,
      firstByteMs,
      totalMs,
      // What the server says it intends to do with the connection, which settles
      // the question no amount of timing can.
      connectionHeader: response.headers.get("connection") ?? "(none)",
      keepAliveHeader: response.headers.get("keep-alive") ?? "(none)"
    };
  } catch (error) {
    return { label, error: error.message };
  }
}

function fromJson(raw) {
  try {
    const payload = JSON.parse(raw);
    const choice = payload.choices?.[0];
    return choice?.text ?? choice?.message?.content ?? payload.response ?? "";
  } catch {
    return raw.slice(0, 200);
  }
}

function fromEvents(raw) {
  let text = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const choice = JSON.parse(data).choices?.[0];
      text += choice?.text ?? choice?.delta?.content ?? "";
    } catch {
      // A keep-alive or a comment line, which is not part of the completion.
    }
  }
  return text;
}

const CHAT_SYSTEM =
  "You are a code completion engine. Reply with the code that belongs at the cursor and nothing else.";

const fimBody = (id, prefix = PREFIX, suffix = SUFFIX, maxTokens = 32) => ({
  model: id, prompt: prefix, suffix, max_tokens: maxTokens, temperature: 0.2, stream: true
});

const chatBody = (id, prefix = PREFIX, suffix = SUFFIX, maxTokens = 32) => ({
  model: id,
  max_tokens: maxTokens,
  temperature: 0.2,
  stream: true,
  messages: [
    { role: "system", content: CHAT_SYSTEM },
    { role: "user", content: `<before_cursor>\n${prefix}\n</before_cursor>\n<after_cursor>\n${suffix}\n</after_cursor>` }
  ]
});

const probes = [
  {
    label: "native FIM (prompt + suffix fields, what Dext sends today)",
    path: "/completions",
    body: fimBody(model)
  },
  ...Object.entries(FORMATS).map(([name, build]) => ({
    label: `client-built ${name} sentinels (single prompt field)`,
    path: "/completions",
    body: { model, prompt: build(PREFIX, SUFFIX), max_tokens: 32, temperature: 0.2, stream: true }
  })),
  {
    label: "chat completions (Dext's openai-chat format)",
    path: "/chat/completions",
    body: chatBody(model)
  }
];

/** Cases whose right answer is decided by the surrounding code rather than by
 * taste, so a machine can mark them. They test the two things a completion model
 * has to get right and a chat model most often does not: reading the rest of the
 * file, and then writing one line and stopping. */
const QUALITY_CASES = [
  {
    name: "reads a constant defined below",
    prefix: "# Returns the constant defined at the bottom of this file.\ndef compute():\n    return MAGIC_",
    suffix: "\n\nMAGIC_CONSTANT_ZEBRA = 42\n",
    wants: /^CONSTANT_ZEBRA/
  },
  {
    name: "calls a helper defined above",
    prefix: "function clampToRange(value: number, min: number, max: number): number {\n"
      + "  return Math.min(Math.max(value, min), max);\n}\n\n"
      + "export function normalizeVolume(input: number): number {\n  return ",
    suffix: "\n}\n",
    wants: /clampToRange\s*\(/
  },
  {
    name: "continues an obvious pattern",
    prefix: 'COLORS = {\n    "red": "#ff0000",\n    "green": "#00ff00",\n    "blue": "',
    suffix: '",\n}\n',
    wants: /^#0{4}ff/i
  },
  {
    name: "picks a field that exists",
    prefix: "interface LineItem {\n  quantity: number;\n  unitPrice: number;\n}\n\n"
      + "const items: LineItem[] = load();\nconst total = items.reduce((sum, item) => sum + item.",
    suffix: ", 0);\n",
    wants: /^(unitPrice|quantity)\b/
  },
  {
    name: "writes the one obvious line",
    prefix: "def is_even(n: int) -> bool:\n    return ",
    suffix: "\n",
    wants: /n\s*%\s*2\s*==\s*0/
  },
  {
    name: "closes a call it opened",
    prefix: 'import { join } from "node:path";\n\n'
      + "export function configPath(home: string): string {\n  return join(",
    suffix: "\n}\n",
    wants: /home\s*,/
  }
];

/** The same tidying Dext does before showing ghost text. Marking the raw reply
 * instead would fail a model for a fence Dext already strips, and pass one for a
 * leaked prompt tag Dext now cuts. Either way the score would describe the model
 * rather than what the user would see. */
function asDextWouldShow(text) {
  const unfenced = text.replace(/^\s*```[^\n]*\n/, "").replace(/```[\s\S]*$/, "");
  return unfenced.replace(/^\n+/, "").replace(/<\/?(?:before|after)_cursor>[\s\S]*$/, "").trimEnd();
}

/** Faults that survive that tidying and make a completion unusable however
 * clever it is: a chat model explaining itself, running on for a screenful, or
 * writing out the code that already sits after the cursor. */
function discipline(text, suffix) {
  const faults = [];
  if (/^\s*(here|this|the |sure|to )/i.test(text)) faults.push("prose");
  if (text.length > 120) faults.push(`${text.length} chars`);
  const nextLine = suffix.split("\n").map((line) => line.trim()).find(Boolean);
  if (nextLine && text.includes(nextLine)) faults.push("repeats the suffix");
  return faults;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

console.log(`Endpoint: ${endpoint}`);
console.log(`Model:    ${modelList.length ? `${modelList.length} in rotation` : model}`);
if (modelList.length) console.log(`Shapes:   ${modelList.map((c) => `${c.id}(${c.shape})`).join(", ")}`);
console.log(`API key:  ${key ? "provided" : "MISSING (set DEXT_PROBE_KEY)"}`);
console.log(`Samples:  ${repeat} each, after a warm-up\n`);

// Pays the DNS and TLS cost once, so it does not land on whichever shape
// happens to be measured first and make it look slower than the rest.
process.stdout.write("warming the connection... ");
const warmup = await send("warm-up", "/completions", {
  model: model || modelList[0].id,
  prompt: "x",
  max_tokens: 1,
  stream: false
});
console.log(warmup.error ? `failed: ${warmup.error}` : `done in ${warmup.totalMs}ms (cold: includes DNS and TLS)\n`);

if (modelList.length && args.has("quality")) {
  console.log("## quality, marked on cases whose answer the surrounding code decides\n");
  for (const candidate of modelList) {
    const marks = [];
    for (const test of QUALITY_CASES) {
      const body = candidate.shape === "chat"
        ? chatBody(candidate.id, test.prefix, test.suffix, 64)
        : fimBody(candidate.id, test.prefix, test.suffix, 64);
      const path = candidate.shape === "chat" ? "/chat/completions" : "/completions";
      const run = await send(candidate.id, path, body);
      const shown = asDextWouldShow(run.text ?? "");
      // Ghost text on the cursor's line is what the reader actually judges.
      const line = shown.split("\n")[0]?.trim() ?? "";
      const faults = run.error ? ["request failed"] : discipline(shown, test.suffix);
      // Flagged separately: Dext strips these now, but a model that emits them
      // is one bug away from writing the prompt into the file.
      if (/```|<\/?(?:before|after)_cursor>/.test(run.text ?? "")) faults.push("needed cleaning up");
      const right = !run.error && test.wants.test(line);
      marks.push({ test, text: run.error ? run.error.slice(0, 60) : line, right, faults });
    }
    // "Needed cleaning up" does not cost a mark, because Dext does clean it up.
    const passed = marks.filter((mark) => mark.right).length;
    console.log(`### ${candidate.id} (${candidate.shape})  —  ${passed}/${marks.length}\n`);
    for (const mark of marks) {
      const verdict = mark.right ? (mark.faults.length ? "warn" : " ok ") : "FAIL";
      console.log(`   [${verdict}] ${mark.test.name.padEnd(30)} ${JSON.stringify(mark.text)}`);
      if (mark.faults.length) console.log(`          ${mark.faults.join(", ")}`);
    }
    console.log("");
  }
  console.log("Answers are marked after the tidying Dext does, so a fence or a leaked prompt");
  console.log("tag is noted but not penalised. A 'warn' is correct with something Dext had to");
  console.log("clean up. Read the completions as well as the score: only you can judge whether");
  console.log("they read like the code you would have written.");
  process.exit(0);
}

if (modelList.length) {
  // Round-robin rather than all of one model then all of the next. This gateway
  // was measured drifting by a factor of four over ten minutes, so running the
  // models in blocks would rank them by when they happened to be tested.
  const results = new Map(modelList.map((candidate) => [candidate.entry, []]));
  for (let round = 0; round < repeat; round += 1) {
    process.stdout.write(`round ${round + 1}/${repeat}: `);
    for (const candidate of modelList) {
      process.stdout.write(".");
      results.get(candidate.entry).push(candidate.shape === "chat"
        ? await send(candidate.entry, "/chat/completions", chatBody(candidate.id))
        : await send(candidate.entry, "/completions", fimBody(candidate.id)));
    }
    process.stdout.write("\n");
  }

  console.log("\n## fill-in-the-middle, one request each, in rotation\n");
  const ranked = [];
  const width = Math.max(...modelList.map((candidate) => candidate.id.length)) + 2;
  for (const candidate of modelList) {
    const runs = results.get(candidate.entry);
    const ok = runs.filter((run) => !run.error);
    const via = candidate.shape === "chat" ? "chat" : "FIM ";
    if (!ok.length) {
      console.log(`   ${candidate.id.padEnd(width)} ${via}  unusable: ${runs[0].error}`);
      continue;
    }
    const correct = ok.filter((run) => run.text.includes(MARKER)).length;
    const firstByte = median(ok.map((run) => run.firstByteMs));
    ranked.push({
      id: candidate.id, via, firstByte, total: median(ok.map((run) => run.totalMs)), correct, of: ok.length
    });
  }
  // Sorted by the number that decides whether a suggestion feels instant.
  for (const row of ranked.sort((a, b) => a.firstByte - b.firstByte)) {
    console.log(
      `   ${row.id.padEnd(width)} ${row.via}  first byte ${String(row.firstByte).padStart(5)}ms`
      + `   total ${String(row.total).padStart(5)}ms`
      + `   correct ${row.correct}/${row.of}`
      + (row.correct === row.of ? "" : "   <- cannot fill in the middle")
    );
  }
  console.log("");
  console.log("   Only a model that is correct on every attempt is a candidate; the rest are");
  console.log("   fast because they answered with nothing useful. Remember that a pause of more");
  console.log("   than a few seconds adds a reconnect on top of these numbers, for every model.");
  process.exit(0);
}

// First-byte times of the shape Dext actually sends, kept as the yardstick the
// idle sweep is measured against.
let baseline = [];

for (const probe of probes) {
  const runs = [];
  const connectionsBefore = connectionsMade();
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    runs.push(await send(probe.label, probe.path, probe.body));
  }
  const connectionsUsed = connectionsMade() - connectionsBefore;
  console.log(`## ${probe.label}`);
  const failures = runs.filter((run) => run.error);
  if (failures.length === runs.length) {
    console.log(`   failed: ${failures[0].error}\n`);
    continue;
  }
  const ok = runs.filter((run) => !run.error);
  const sawSuffix = ok.filter((run) => run.text.includes(MARKER)).length;
  const firstBytes = ok.map((run) => run.firstByteMs);
  const totals = ok.map((run) => run.totalMs);
  if (probe === probes[0]) baseline = firstBytes;
  console.log(`   saw the suffix: ${sawSuffix === ok.length ? "YES" : sawSuffix ? `sometimes (${sawSuffix}/${ok.length})` : "no"}`);
  console.log(`   streamed:       ${ok[0].streamed ? `yes, ~${ok[0].chunks} chunks` : `no, one whole body`}`);
  console.log(`   first byte:     median ${median(firstBytes)}ms  (best ${Math.min(...firstBytes)}ms, worst ${Math.max(...firstBytes)}ms)`);
  console.log(`   total:          median ${median(totals)}ms  (best ${Math.min(...totals)}ms, worst ${Math.max(...totals)}ms)`);
  if (failures.length) console.log(`   note:           ${failures.length}/${runs.length} attempts failed: ${failures[0].error}`);
  console.log(
    `   connections:    ${connectionsUsed} new for ${runs.length} back-to-back requests`
    + `  [Connection: ${ok[0].connectionHeader}, Keep-Alive: ${ok[0].keepAliveHeader}]`
  );
  console.log(`   completion:     ${JSON.stringify(ok.at(-1).text.slice(0, 160))}\n`);
}

if (idleSweep.length) {
  const shape = probes[0];
  const warm = median(baseline);
  console.log("## what a pause costs (same request, after sitting idle)\n");
  console.log(`   no pause (median of ${baseline.length} back-to-back): ${warm}ms to first byte\n`);
  for (const pause of idleSweep) {
    await new Promise((resolve) => setTimeout(resolve, pause * 1000));
    const before = connectionsMade();
    const after = await send(shape.label, shape.path, shape.body);
    // Read between the two, or the control's own connection is charged to the
    // pause and every pause looks like it dropped the socket.
    const reconnected = connectionsMade() > before;
    // A control taken straight afterwards, on a connection that is certainly
    // warm. The gateway drifts over the minute a sweep takes, so the pause has
    // to be priced against a baseline from the same moment, not from the start.
    const control = await send(shape.label, shape.path, shape.body);
    if (after.error || control.error) {
      console.log(`   after ${String(pause).padStart(3)}s idle:  failed: ${(after.error ?? control.error)}`);
      continue;
    }
    console.log(
      `   after ${String(pause).padStart(3)}s idle:  ${String(after.firstByteMs).padStart(5)}ms`
      + `   vs ${String(control.firstByteMs).padStart(5)}ms right after`
      + `   | new connection: ${reconnected ? "YES" : "no"}`
    );
  }
  console.log("");
  console.log("   'new connection: YES' means Node dropped the idle socket and paid for a fresh");
  console.log("   handshake, which a longer-lived pool fixes. All 'no' means the connection was");
  console.log("   reused and any difference in the two timings is just the gateway wandering.\n");
}

console.log("A shape that says 'saw the suffix: YES' knows what comes after the cursor.");
console.log("Compare the median first byte: that is the wait before anything can be shown,");
console.log("and on this kind of gateway it is nearly the whole wait.");
