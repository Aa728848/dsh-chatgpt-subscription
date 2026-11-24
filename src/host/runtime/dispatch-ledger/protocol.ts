/**
 * Mandate v2 的**完整协议正文**。
 *
 * ## 为什么协议正文住在工具结果里，而不是 preset 里
 *
 * 协议正文有 4KB 上下，而 dispatch preset 的 persona prefix 已经占掉
 * 17401 字符（预算 18500）。把协议塞进 persona 会直接破预算；塞进工具描述
 * 会让工具声明面随会话变化。
 *
 * 所以：**协议正文只出现在 `dispatch_ledger {action:"self"}` 的返回体尾部**，
 * 工具描述保持静态且短（≤240 字符），preset 里只留一行短引导。模型读到的
 * 工具结果尾部就是协议本身。
 *
 * ## 样板必须自洽
 *
 * 正文里出现的每一段围栏，都是模型会**照抄**的样板；样板一旦不合文法，模型
 * 抄一次就被拒一次，而它没有别的依据可循。所以样板与 {@link ./header.ts} 的
 * schema 必须互相自洽：`test/dispatch-ledger-header.test.ts` 会把正文里的
 * 每一段围栏都丢给真解析器，判不出 `ok` 就算回归。
 *
 * ## 长度上限
 *
 * 协议正文必须 ≤ {@link DISPATCH_MANDATE_PROTOCOL_MAX_CHARS} 字符。这条上限
 * 由测试守住：协议一超预算，模型的一次工具结果就撑破上下文预算。
 *
 * @module dsh-chatgpt-subscription/host/dispatch-ledger/protocol
 */

/** 协议正文的字符上限。 */
export const DISPATCH_MANDATE_PROTOCOL_MAX_CHARS = 4096

/** 完整的 Mandate v2 协议正文。 */
export const DISPATCH_MANDATE_PROTOCOL: string = [
  'Dispatch Ledger - Mandate protocol v2',
  '',
  '1. HEADER. Put ONE fenced block at the VERY START of the text you pass to',
  '`subagent.prompt` (dispatch) or `send_message.message` (report/steer). Nothing',
  'may precede it; the body follows the closing fence.',
  '',
  '```dsh-mandate-v2',
  '{',
  '  "v": 2,',
  '  "kind": "dispatch",',
  '  "brief_id": "b-7f",',
  '  "run_id": "r-1",',
  '  "idem": "i-1",',
  '  "mandate_version": 1,',
  '  "prompt_ref": "plan-v3",',
  '  "policy": {',
  '    "id": "dsh-dispatch-ledger",',
  '    "version": "1",',
  '    "sha256": "3f9a1c2b3c4d5e6f"',
  '  },',
  '  "task": ["task://req-42"],',
  '  "boundary": ["src/host/dispatch-ledger/**"],',
  '  "followup": ["ctx://plan-v3"],',
  '  "parent_mandate": null',
  '}',
  '```',
  '',
  '2. PER KIND. Each kind carries its own fields and NO others: one foreign field',
  'makes the whole header malformed.',
  '- dispatch: the block above. task: <=4 references (<=160 chars) naming the',
  '  request, NOT its text. boundary: <=16 entries (<=120 chars). followup: <=8',
  '  references (<=120 chars). parent_mandate: null on the first run of a brief,',
  '  else the {brief_id, run_id, idem} of the run this one replaces.',
  '- report: the same block MINUS task, boundary, followup and parent_mandate, PLUS',
  '  "status":"ready"|"hand_back"|"blocked"|"failed"|"dropped". Copy brief_id,',
  '  run_id, idem, mandate_version, prompt_ref and policy from the dispatch header',
  '  you received (or read them with dispatch_ledger {action:"self"} if needed).',
  '- steer: the same block MINUS task, boundary, followup and parent_mandate, PLUS',
  '  "grant": {"context":["..."]} (entries already in that run followup) or null.',
  '',
  '3. FIELDS. v = 2, mandate_version = 1. brief_id: the work item, stable across',
  'runs, <=64 chars from [A-Za-z0-9._:-]. run_id: one dispatch attempt. idem: the',
  'idempotency key inside one run; both are NEW after a hand_back. prompt_ref and',
  'policy: copy verbatim from dispatch_ledger {action:"self"}; never invent them.',
  'The host seals the body by hashing it, so never put a hash in the header: an',
  'unknown field makes the header malformed.',
  '',
  '4. FLOW.',
  'a. Coordinator calls dispatch_ledger {action:"self"} ONCE before its first',
  '   delegation. Copy policy and prompt_ref from it; this protocol is at its TAIL.',
  'b. Dispatch: dispatch header + task text, in `subagent.prompt`.',
  'c. Child reuses brief_id/run_id/idem/mandate_version/prompt_ref/policy from the',
  '   received dispatch header (or calls dispatch_ledger {action:"self"} if needed).',
  'd. Report: return your completion report directly at turn end, or if reporting',
  '   via `send_message` to your parent agent id, prepend the report header.',
  'e. Steer: steer header, in `send_message` to the child.',
  '',
  '5. REJECTION CODES. These are the only denials; each one names its fix.',
  'MANDATE_MALFORMED: the header does not parse, or carries a field its kind does',
  '  not allow. Re-send with exactly the fields of that kind.',
  'MANDATE_KIND: the kind does not match the tool.',
  'MANDATE_DUPLICATE: the namespace (brief_id, run_id, idem) is claimed by an attempt',
  '  that actually dispatched, and is never reusable after that. Use a NEW run_id AND',
  '  a NEW idem, and set parent_mandate. A call rejected before dispatch (for instance',
  '  for its provider/model) does not claim the namespace, so retry with the SAME ids.',
  'MANDATE_BRIEF_BUSY: another run of this brief is still booked. Wait, or use a new brief_id.',
  'MANDATE_LINEAGE_REQUIRED: the brief already has a run, but parent_mandate is missing.',
  'MANDATE_LINEAGE: parent_mandate does not point at the latest settled run of the brief.',
  'MANDATE_POLICY_STALE: the policy block is not current. Copy it from self again.',
  'MANDATE_VERSION: mandate_version or prompt_ref does not match the recorded run.',
  'MANDATE_NOT_PARENT: the agent you report to is not your parent.',
  'MANDATE_NOT_CHILD: the agent you steer is not your child.',
  'MANDATE_GRANT_EXCEEDS: grant.context asks for context outside followup.',
  'MANDATE_NOT_HELD: you do not hold this mandate.',
  'MANDATE_LEDGER_FULL: the ledger is full. Report it; never reuse an old namespace.',
  '',
  '6. A dispatch with no header is allowed but audited, and cannot be de-duplicated.',
].join('\n')
