// A small, purpose-built YAML reader for GitHub workflow files.
//
// Why not a real YAML library: the project has no YAML dependency, and R4-1 forbids adding
// runtime dependencies (and package.json is only allowed new scripts/fields). Vendoring a full
// parser is not justified for four workflows, so this reads the **block subset** those files
// actually use and throws on anything it does not understand — a mis-parse must fail the suite,
// never silently produce a structure that makes an assertion pass:
//
//   * block mappings and block sequences, nested by indentation (spaces only);
//   * inline mapping starts inside a sequence item (`- uses: actions/checkout@v4` plus the
//     following deeper-indented keys — the shape every workflow step has);
//   * flow sequences (`["v*"]`, `[a, b]`) and flow mappings (`{a: b}`);
//   * single/double-quoted and plain scalars, `true`/`false`/`null`/numbers;
//   * literal/folded block scalars (`run: |`), which is how multi-line `run:` steps appear;
//   * `#` comments (full-line and trailing, never inside quotes);
//   * `---` document start (ignored).
//
// Conspicuously *not* supported: anchors/aliases, tags, multi-document streams, tabs for
// indentation. Each of those throws.

/** A parsed YAML scalar. */
export type YamlScalar = string | number | boolean | null;
/** A parsed YAML value. */
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };
/** A parsed YAML mapping. */
export type YamlMapping = { [key: string]: YamlValue };

/** Thrown for any construct this reader does not implement (1-based line numbers). */
export class YamlError extends Error {
  public constructor(message: string, line: number) {
    super(`yaml:${String(line)}: ${message}`);
    this.name = "YamlError";
  }
}

interface Line {
  indent: number;
  text: string;
  number: number;
  /** Blank lines carry no indentation and are only meaningful inside block scalars. */
  blank: boolean;
}

function preprocess(text: string): Line[] {
  const lines: Line[] = [];
  const raw = text.split(/\r?\n/u);
  for (let index = 0; index < raw.length; index++) {
    const source = raw[index] ?? "";
    if (/^\s*$/u.test(source)) {
      // Kept (marked blank) so a `run: |` script keeps its shape; block structure ignores them.
      lines.push({ indent: 0, text: "", number: index + 1, blank: true });
      continue;
    }
    if (/^\s*#/u.test(source)) continue;
    if (/^---\s*$/u.test(source)) continue;
    if (/^\s*%/u.test(source)) throw new YamlError("directives are not supported", index + 1);
    const indentation = /^[ \t]*/u.exec(source)?.[0] ?? "";
    if (indentation.includes("\t")) throw new YamlError("tabs cannot be used for indentation", index + 1);
    lines.push({
      indent: indentation.length,
      text: source.slice(indentation.length).replace(/\s+$/u, ""),
      number: index + 1,
      blank: false,
    });
  }
  return lines;
}

/** Index of the next non-blank line at or after `index`. */
function skipBlanks(lines: Line[], index: number): number {
  let cursor = index;
  while (cursor < lines.length && lines[cursor]?.blank === true) cursor++;
  return cursor;
}

/** Strips a trailing comment, honoring quotes. */
function stripComment(text: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index] ?? "";
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (character === "#" && !single && !double && (index === 0 || text[index - 1] === " " || text[index - 1] === "\t")) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text;
}

function unquote(text: string, line: number): string {
  if (text.length < 2 || text[0] !== text[text.length - 1]) {
    throw new YamlError(`unterminated quoted scalar: ${text}`, line);
  }
  const body = text.slice(1, -1);
  if (text.startsWith("'")) return body.replaceAll("''", "'");
  if (text.startsWith('"')) {
    return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gu, (_match, escape: string) => {
      switch (escape) {
        case "n": return "\n";
        case "t": return "\t";
        case "r": return "\r";
        case '"': return '"';
        case "\\": return "\\";
        case "/": return "/";
        case "0": return "\0";
        default: return escape;
      }
    });
  }
  throw new YamlError(`unexpected quote handling for: ${text}`, line);
}

/** Splits `key: value` on the first top-level colon, or returns `null`. */
function splitKeyValue(text: string): { key: string; rest: string } | null {
  let single = false;
  let double = false;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index] ?? "";
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (!single && !double && (character === "[" || character === "{")) depth++;
    else if (!single && !double && (character === "]" || character === "}")) depth--;
    else if (character === ":" && !single && !double && depth === 0) {
      const next = text[index + 1];
      if (next === undefined || next === " ") {
        const rawKey = text.slice(0, index).trim();
        const key = rawKey.startsWith("'") || rawKey.startsWith('"') ? unquote(rawKey, 0) : rawKey;
        return { key, rest: stripComment(text.slice(index + 1).trim()) };
      }
    }
  }
  return null;
}

function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let single = false;
  let double = false;
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    if (!single && !double && (character === "[" || character === "{")) depth++;
    if (!single && !double && (character === "]" || character === "}")) depth--;
    if (character === "," && !single && !double && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

const ANCHOR_OR_ALIAS = /^[&*][A-Za-z0-9_]/u;

function parseScalar(text: string, line: number): YamlValue {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (ANCHOR_OR_ALIAS.test(trimmed)) {
    // `&anchor value`, `&anchor`, `*alias`: a real YAML reader would resolve these; refusing is
    // the only honest option, because silently keeping `&anchor value` as a literal string would
    // let a workflow edit slip past the structural assertions.
    throw new YamlError(`anchors/aliases are not supported: ${trimmed}`, line);
  }
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) return unquote(trimmed, line);
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) throw new YamlError(`unterminated flow sequence: ${trimmed}`, line);
    return splitFlow(trimmed.slice(1, -1)).map((item) => parseScalar(item, line));
  }
  if (trimmed.startsWith("{")) {
    if (!trimmed.endsWith("}")) throw new YamlError(`unterminated flow mapping: ${trimmed}`, line);
    const mapping: YamlMapping = {};
    for (const entry of splitFlow(trimmed.slice(1, -1))) {
      const pair = splitKeyValue(entry);
      if (pair === null) throw new YamlError(`expected "key: value" inside a flow mapping, found ${entry}`, line);
      mapping[pair.key] = parseScalar(pair.rest, line);
    }
    return mapping;
  }
  if (/^(true|True|TRUE)$/u.test(trimmed)) return true;
  if (/^(false|False|FALSE)$/u.test(trimmed)) return false;
  if (/^(null|Null|NULL|~)$/u.test(trimmed)) return null;
  if (/^-?\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/u.test(trimmed)) return Number.parseFloat(trimmed);
  // GitHub expressions such as `!cancelled()` start with `!`, which YAML would read as a tag;
  // treating them as plain text is the useful reading here and cannot change an assertion.
  return trimmed;
}

function parseBlockScalar(lines: Line[], start: number, keyIndent: number, header: string): { value: string; next: number } {
  const folded = header.startsWith(">");
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  const collected: string[] = [];
  let index = start;
  let blockIndent: number | null = null;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.blank) {
      // A blank line belongs to the block until a less-indented line ends it (decided below).
      collected.push("");
      index++;
      continue;
    }
    if (line.indent <= keyIndent) break;
    blockIndent ??= line.indent;
    if (line.indent < blockIndent) break;
    // Re-indent relative to the block, keeping internal indentation meaningful.
    collected.push(" ".repeat(line.indent - blockIndent) + line.text);
    index++;
  }
  // Trailing blanks never belong to the scalar.
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
  let value = folded
    ? collected.map((entry, position) => (entry === "" ? "\n" : position === 0 ? entry : ` ${entry}`)).join("")
    : collected.join("\n");
  if (chomp === "clip" && value !== "") value += "\n";
  return { value, next: skipBlanks(lines, index) };
}

function parseNode(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const index = skipBlanks(lines, start);
  const first = lines[index];
  if (first === undefined) throw new YamlError("unexpected end of input", 0);
  if (first.text === "-" || first.text.startsWith("- ")) return parseSequence(lines, index, indent);
  return parseMapping(lines, index, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): { value: YamlValue[]; next: number } {
  const items: YamlValue[] = [];
  let index = skipBlanks(lines, start);
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent !== indent) break;
    if (line.text !== "-" && !line.text.startsWith("- ")) break;
    const itemText = line.text === "-" ? "" : stripComment(line.text.slice(2).trim());
    if (itemText === "") {
      const nextIndex = skipBlanks(lines, index + 1);
      const next = lines[nextIndex];
      if (next === undefined || next.indent <= indent) {
        items.push(null);
        index = nextIndex;
        continue;
      }
      const child = parseNode(lines, nextIndex, next.indent);
      items.push(child.value);
      index = skipBlanks(lines, child.next);
      continue;
    }
    if (itemText.startsWith("- ")) throw new YamlError("nested inline sequences are not supported", line.number);
    const pair = splitKeyValue(itemText);
    if (pair === null) {
      items.push(parseScalar(itemText, line.number));
      index = skipBlanks(lines, index + 1);
      continue;
    }
    // `- key: value` starts a mapping whose keys live at indent + 2. Rewrite this line at that
    // indentation and parse the mapping from here, so the following keys join the same object.
    const shift = line.text.length - itemText.length;
    lines[index] = { indent: indent + shift, text: itemText, number: line.number, blank: false };
    const child = parseMapping(lines, index, indent + shift);
    items.push(child.value);
    index = skipBlanks(lines, child.next);
  }
  return { value: items, next: index };
}

function parseMapping(lines: Line[], start: number, indent: number): { value: YamlMapping; next: number } {
  const mapping: YamlMapping = {};
  let index = skipBlanks(lines, start);
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent !== indent) break;
    if (line.text === "-" || line.text.startsWith("- ")) break;
    const pair = splitKeyValue(line.text);
    if (pair === null) throw new YamlError(`expected "key: value", found ${JSON.stringify(line.text)}`, line.number);
    const { key, rest } = pair;
    if (Object.hasOwn(mapping, key)) {
      // Fail loud instead of letting the last duplicate win: GitHub rejects duplicate keys, and a
      // silent overwrite is exactly how a hidden `run:`/`uses:` could be masked from the
      // structural publish-surface assertions.
      throw new YamlError(`duplicate key ${JSON.stringify(key)} at this level`, line.number);
    }
    if (rest === "") {
      const nextIndex = skipBlanks(lines, index + 1);
      const next = lines[nextIndex];
      if (next !== undefined && next.indent > indent) {
        const child = parseNode(lines, nextIndex, next.indent);
        mapping[key] = child.value;
        index = skipBlanks(lines, child.next);
        continue;
      }
      if (next !== undefined && next.indent === indent && (next.text === "-" || next.text.startsWith("- "))) {
        const child = parseSequence(lines, nextIndex, indent);
        mapping[key] = child.value;
        index = skipBlanks(lines, child.next);
        continue;
      }
      mapping[key] = null;
      index = nextIndex;
      continue;
    }
    if (/^[|>][+-]?$/u.test(rest)) {
      const block = parseBlockScalar(lines, index + 1, indent, rest);
      mapping[key] = block.value;
      index = skipBlanks(lines, block.next);
      continue;
    }
    mapping[key] = parseScalar(rest, line.number);
    index = skipBlanks(lines, index + 1);
  }
  return { value: mapping, next: index };
}

/** Parses a YAML document (the block subset described in the module header). */
export function parseYaml(text: string): YamlValue {
  const lines = preprocess(text);
  const start = skipBlanks(lines, 0);
  if (start >= lines.length) return null;
  const rootIndent = lines[start]?.indent ?? 0;
  const parsed = parseNode(lines, start, rootIndent);
  const rest = skipBlanks(lines, parsed.next);
  if (rest < lines.length) {
    const leftover = lines[rest];
    throw new YamlError(`unexpected content after the document: ${JSON.stringify(leftover?.text ?? "")}`, leftover?.number ?? 0);
  }
  return parsed.value;
}

/** Narrows a value to a mapping, throwing with `where` for a helpful failure. */
export function asMapping(value: YamlValue | undefined, where: string): YamlMapping {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new YamlError(`${where} must be a mapping`, 0);
  }
  return value;
}

/** Narrows a value to a sequence, throwing with `where` for a helpful failure. */
export function asSequence(value: YamlValue | undefined, where: string): YamlValue[] {
  if (!Array.isArray(value)) throw new YamlError(`${where} must be a sequence`, 0);
  return value;
}

/** Reads a string scalar, or `null` when absent. */
export function asString(value: YamlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}
