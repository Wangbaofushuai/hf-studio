/** 剥离 LLM 输出可能包裹的 markdown 代码围栏（```html ... ```）——
 *  推理模型（如 deepseek-v4-flash）习惯性包裹输出，直接写盘会让 hyperframes 解析失败
 * （lint 报 root_missing_composition_id 等——E2E 实测 3 轮全败于此） */
export function stripCodeFences(content: string): string {
  return content.trim().replace(/^```(?:html|xml)?\s*/i, "").replace(/```\s*$/, "");
}
