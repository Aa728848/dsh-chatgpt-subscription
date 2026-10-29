/**
 * Recovery of tool calls the model PRINTED instead of emitting structurally.
 *
 * Measured upstream behaviour (and the reason workbuddy2api-hub has the same
 * recovery, `wb_proxy.py` "Printed tool calls on the Chat Completions path"):
 * a tools request sometimes answers with the call spelled out inside `content`
 * — either the full-width DSML form
 *
 *     <||DSML|| calls><||DSML|| invoke name="run_code">
 *       <||DSML|| parameter name="code">print(1)</||DSML|| parameter>
 *     </||DSML|| invoke></||DSML|| calls>
 *
 * or a hybrid the model mixes on its own: a plain opening tag closed by DSML
 * tags, with the first parameter's close tag swallowed. Forwarded verbatim the
 * client sees prose, finds no call, and the turn simply ends — reported by
 * users as "it keeps stopping by itself".
 *
 * A structured `tool_calls` delta always wins; this only runs for text, which
 * is why the recovery is a pure function over the accumulated content.
 */

import { randomUUID } from 'node:crypto';

/** One recovered call, in the shape the mapper emits. */
export interface PrintedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A successful recovery: the calls plus the prose left behind. */
export interface PrintedRecovery {
  calls: PrintedToolCall[];
  clean: string;
}

const TAG_START = '<[^>]*DSML[^>]*';
const CALLS_RE = new RegExp(`${TAG_START}calls>(.*?)</[^>]*DSML[^>]*calls>`, 's');
const INVOKE_RE = new RegExp(`${TAG_START}invoke\\s+name=["']([^"']+)["']>(.*?)</[^>]*invoke>`, 's');
const DSML_PARAM_RE = new RegExp(`${TAG_START}parameter\\s+name=["']([^"']+)["'][^>]*>(.*?)</[^>]*parameter>`, 's');

const PARAM_TAGS = 'parameter|param|arg|argument';
const LEAK_PARAM_RE = new RegExp(
  `<\\s*(?:\\|\\s*DSML\\s*\\|\\s*)?(${PARAM_TAGS})\\b([^>]*)>(.*?)</\\s*(?:\\|\\s*DSML\\s*\\|\\s*)?(?:parameter|param|arg|argument)\\s*>`,
  'gis',
);
const LEAK_TAG_RE = /<\s*\/?\s*(?:\|\s*DSML\s*\|\s*)?([A-Za-z_][A-Za-z0-9_]*)([^>]*)>/g;
const LEAK_NAME_ATTR_RE = /name\s*=\s*["']([^"']*)["']/;
const WRAPPER_TAGS = new Set(['calls', 'tool_calls', 'function_calls', 'function_call']);

/** Fold the full-width spelling of the DSML token back to ASCII bars. */
function normalizeDsmlBars(text: string): string {
  return text.replace(/\uff5c+\s*DSML\s*\uff5c+/g, '|DSML|');
}

function callId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function argumentsOf(params: Record<string, string>): string {
  return JSON.stringify(params);
}

function stripSpans(text: string, spans: readonly (readonly [number, number])[]): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const kept: string[] = [];
  let last = 0;
  for (const [start, end] of sorted) {
    if (start < last) continue;
    kept.push(text.slice(last, start));
    last = end;
  }
  kept.push(text.slice(last));
  return kept.join('').trim();
}

/** Recover the full-width `<||DSML|| …>` spelling. */
export function parseDsmlToolCalls(text: string): PrintedRecovery | null {
  if (text === '' || !text.includes('DSML')) return null;
  const block = CALLS_RE.exec(text);
  if (block === null) return null;
  const callsBlock = block[1] ?? '';
  const calls: PrintedToolCall[] = [];
  for (const invoke of callsBlock.matchAll(new RegExp(INVOKE_RE.source, 'gs'))) {
    const params: Record<string, string> = {};
    for (const param of (invoke[2] ?? '').matchAll(new RegExp(DSML_PARAM_RE.source, 'gs'))) {
      params[param[1] ?? ''] = (param[2] ?? '').trim();
    }
    calls.push({ id: callId(), name: invoke[1] ?? '', arguments: argumentsOf(params) });
  }
  if (calls.length === 0) return null;
  const before = text.slice(0, block.index).trim();
  const after = text.slice(block.index + block[0].length).trim();
  return { calls, clean: `${before} ${after}`.trim() };
}

interface ParamSite {
  start: number;
  name: string;
  value: string;
  end: number;
}

interface TagSite {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  attrs: string;
}

/**
 * Recover the hybrid spelling, driven by the `<parameter>` elements.
 *
 * Parameter elements are spelled the same way in both shapes and a parameter
 * name is the one thing a call cannot do without, so they are the anchor; the
 * nearest preceding opening tag that is neither a wrapper nor a parameter names
 * the tool.
 */
export function parseLeakedToolCalls(text: string): PrintedRecovery | null {
  if (text === '' || !text.includes('<')) return null;
  const normalized = normalizeDsmlBars(text);

  const params: ParamSite[] = [];
  for (const match of normalized.matchAll(LEAK_PARAM_RE)) {
    const attrs = match[2] ?? '';
    const attr = LEAK_NAME_ATTR_RE.exec(attrs);
    const name = attr?.[1] ?? '';
    if (name === '' || match.index === undefined) continue;
    params.push({
      start: match.index,
      name,
      value: (match[3] ?? '').trim(),
      end: match.index + match[0].length,
    });
  }
  if (params.length === 0) return null;

  const tags: TagSite[] = [];
  for (const match of normalized.matchAll(LEAK_TAG_RE)) {
    if (match.index === undefined) continue;
    tags.push({
      start: match.index,
      end: match.index + match[0].length,
      name: (match[1] ?? '').toLowerCase(),
      closing: (match[0].trimStart().startsWith('</')),
      attrs: match[2] ?? '',
    });
  }

  interface Group { owner: TagSite | null; params: Record<string, string>; spans: [number, number][] }
  const groups: Group[] = [];
  for (const site of params) {
    let owner: TagSite | null = null;
    for (const tag of tags) {
      if (tag.start >= site.start) break;
      if (tag.closing) continue;
      if (WRAPPER_TAGS.has(tag.name)) continue;
      if (new RegExp(`^(${PARAM_TAGS})$`, 'i').test(tag.name)) continue;
      owner = tag;
    }
    const nameAttr = owner === null ? null : LEAK_NAME_ATTR_RE.exec(owner.attrs);
    const toolName = owner === null ? '' : (nameAttr?.[1] ?? owner.name).trim();
    if (toolName === '') continue;
    const last = groups[groups.length - 1];
    if (last !== undefined && owner !== null && last.owner !== null && last.owner.start === owner.start) {
      last.params[site.name] = site.value;
      last.spans.push([site.start, site.end]);
    } else {
      groups.push({ owner, params: { [site.name]: site.value }, spans: [[site.start, site.end]] });
    }
  }
  if (groups.length === 0) return null;

  const regions: [number, number][] = [];
  const calls: PrintedToolCall[] = [];
  for (const group of groups) {
    const first = group.owner?.start ?? Math.min(...group.spans.map((span) => span[0]));
    let last = Math.max(...group.spans.map((span) => span[1]));
    // Swallow the closing tags trailing the final parameter.
    for (;;) {
      let next = last;
      while (next < normalized.length && ' \t\r\n'.includes(normalized[next] ?? '')) next += 1;
      const tag = /^<\s*\/\s*(?:\|\s*DSML\s*\|\s*)?[A-Za-z_][A-Za-z0-9_]*[^>]*>/i.exec(normalized.slice(next));
      if (tag === null) break;
      last = next + tag[0].length;
    }
    regions.push([first, last]);
    calls.push({
      id: callId(),
      name: (group.owner === null ? '' : (LEAK_NAME_ATTR_RE.exec(group.owner.attrs)?.[1] ?? group.owner.name)).trim(),
      arguments: argumentsOf(group.params),
    });
  }
  if (calls.length === 0) return null;

  let clean = stripSpans(normalized, regions);
  const leftover: [number, number][] = [];
  for (const match of clean.matchAll(LEAK_TAG_RE)) {
    if (match.index === undefined) continue;
    const tagText = normalizeDsmlBars(match[0]).toUpperCase();
    const name = (match[1] ?? '').toLowerCase();
    if (tagText.includes('DSML') || WRAPPER_TAGS.has(name)) {
      leftover.push([match.index, match.index + match[0].length]);
    }
  }
  clean = stripSpans(clean, leftover);
  return { calls, clean };
}

/** Recover a printed call under either spelling. */
export function recoverPrintedToolCalls(text: string): PrintedRecovery | null {
  return parseLeakedToolCalls(text) ?? parseDsmlToolCalls(text);
}

const TAG_NAMES = 'run_code|run_shell|invoke|parameter|param|arg|argument|calls|tool_calls|function_calls|function_call';
const OPENER_RE = new RegExp(`^<\\s*/?\\s*(?:\\|\\s*DSML\\s*\\||(?:${TAG_NAMES})\\b)`, 'i');
const CLOSER_RE = new RegExp(
  `<\\s*/\\s*(?:\\|\\s*DSML\\s*\\|\\s*)?(?:${TAG_NAMES})(?:\\s+[^>]*)?>`,
  'i',
);
const OPENERS = [
  '<run_code', '<run_shell', '<invoke', '<parameter', '<param', '<arg', '<argument',
  '<calls', '<tool_calls', '<function_calls', '<function_call',
  '</run_code', '</run_shell', '</invoke', '</parameter', '</param', '</arg',
  '</argument', '</calls', '</tool_calls', '</function_calls', '</function_call',
  '<|dsml|', '</|dsml|', '<||dsml', '</||dsml',
] as const;

/**
 * Index from which a streaming text buffer must be held back.
 *
 * The earliest `<` that either opens a recognisable tag or could still grow
 * into one (a delta may split `<parameter` across frames), or -1 when the
 * whole buffer is safe to emit as prose.
 */
export function printedCallHoldIndex(text: string): number {
  for (let index = text.indexOf('<'); index !== -1; index = text.indexOf('<', index + 1)) {
    const rest = text.slice(index);
    if (OPENER_RE.test(rest)) return index;
    // A partial spelling: compare the shortest decisive prefix.
    const head = rest.replace(/\s+/g, '').toLowerCase().slice(0, 18);
    if (OPENERS.some((opener) => opener.startsWith(head))) return index;
  }
  return -1;
}

/** Whether a held buffer has already reached a closing tag. */
export function printedCallLooksComplete(text: string): boolean {
  return CLOSER_RE.test(text);
}
