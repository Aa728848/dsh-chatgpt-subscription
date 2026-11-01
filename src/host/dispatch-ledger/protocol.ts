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
export const DISPATCH_MANDATE_PROTOCOL: string = ["Dispatch Ledger - Mandate protocol v2","","1. HEADER. Put the fenced block below at the VERY START of the text you pass to","`subagent.prompt` (dispatch) or to `send_message.message` (report/steer).","Nothing may precede it. The task text follows the closing fence.","","```dsh-mandate-v2","{\"v\":2,\"kind\":\"dispatch\",\"brief_id\":\"b-7f\",\"run_id\":\"r-1\",\"idem\":\"i-1\",\"mandate_version\":1,\"prompt_ref\":\"plan-v3\",\"policy\":{\"id\":\"dsh-dispatch-ledger\",\"version\":\"1\",\"sha256\":\"3f9a1c2b3c4d5e6f\"},\"task\":[\"task://req-42\"],\"boundary\":[\"src/host/dispatch-ledger/**\"],\"followup\":[\"ctx://plan-v3\"],\"parent_mandate\":null,\"grant\":null}","```","","2. FIELDS.","v = 2 (anything else is malformed).","kind: \"dispatch\" (new delegation), \"report\" (child -> owner), \"steer\" (owner -> child).","brief_id: the work item. Stable across runs. <=64 chars, [A-Za-z0-9._:-].","run_id: one dispatch attempt. Use a NEW value after a hand_back.","idem: idempotency key inside one run. Use a NEW value after a hand_back.","mandate_version: 1 (the authorization snapshot version).","prompt_ref: copy it verbatim from dispatch_ledger {action:\"self\"} (the prompt_ref field of",
  "  that result). Never invent one. A report or a steer MUST echo the mandate's own",
  "  prompt_ref unchanged.","policy: {id, version, sha256} copied verbatim from dispatch_ledger {action:\"self\"}.","  sha256 is the first 12 or more hex characters the tool printed.","task: <=4 references (<=160 chars each) naming the original request. NOT the request text.","boundary: <=16 structured boundary entries (<=120 chars each), e.g. \"src/host/dispatch-ledger/**\".","followup: <=8 references (<=120 chars each) naming the context this delegation may later ask for.","parent_mandate: null on the first run of a brief; a later run must set {brief_id, run_id, idem}","  of the run it replaces.","grant (steer only): null, or {context:[...]} where every entry is already in that run followup.","status (report only): ready | hand_back | blocked | failed | dropped.",
  "The body after the closing fence is sealed by the host: it computes the sha256 and",
  "  stores it in the ledger. Do NOT put a hash in the header: an unknown field makes",
  "  the header malformed.","","3. FLOW.","a. Call dispatch_ledger {action:\"self\"} ONCE. Copy policy from the result. This protocol is","   printed at the TAIL of that result.","b. Dispatch: header (kind=dispatch) then the task text, in `subagent.prompt`.","c. The child reads its own mandate with dispatch_ledger {action:\"self\"}.","d. Report: header (kind=report, status=...) then the result, in `send_message` to your parent agent id.","e. Steer: header (kind=steer, grant=...) in `send_message` to the child.","","4. REJECTION CODES. The guard denies only these.","MANDATE_MALFORMED: the header does not parse, or a field is out of range.","MANDATE_KIND: the kind does not match the tool.","MANDATE_DUPLICATE: the namespace (brief_id, run_id, idem) is already claimed. A namespace is","  never reusable, not even after a release. Use a NEW run_id AND a NEW idem, and set parent_mandate.","MANDATE_BRIEF_BUSY: another run of this brief is still booked. Wait for it, or use a new brief_id.","MANDATE_LINEAGE_REQUIRED: this brief already has a run, but parent_mandate is missing.","MANDATE_LINEAGE: parent_mandate does not point at the latest released run of this brief.","MANDATE_POLICY_STALE: the policy block does not match the current one. Re-read","  dispatch_ledger {action:\"self\"} and copy it again.","MANDATE_VERSION: mandate_version or prompt_ref does not match the recorded run.","MANDATE_NOT_PARENT / MANDATE_NOT_CHILD: the other side is not your parent / not your child.","MANDATE_GRANT_EXCEEDS: grant.context asks for context outside followup.","MANDATE_NOT_HELD: you do not hold this mandate.",
  "MANDATE_LEDGER_FULL: the ledger reached its run or brief limit. Report it; never",
  "  reuse an old namespace to get around it.","","5. A dispatch without a header is allowed but audited, and it cannot be de-duplicated.","   After a hand_back the new run needs a NEW run_id and a NEW idem: never reuse the old ones."]
  .join('\n')
