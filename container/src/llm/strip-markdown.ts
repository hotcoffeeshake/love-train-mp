/**
 * 把 LLM 输出里的 markdown 标记清理成口语段落。
 * 只剥格式标记，不动文字内容。
 */
export function stripMarkdown(s: string): string {
  if (!s) return s;
  return s
    // 代码块（先于行内 ` 处理）
    .replace(/```[\s\S]*?```/g, '')
    // 行内代码
    .replace(/`([^`\n]+)`/g, '$1')
    // 标题：# / ## / ### ... （行首）
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    // 加粗：**xx** / __xx__
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    // 斜体：*xx* / _xx_（避开 **xx** 的剩余单星号已处理过）
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, '$1')
    // 行首列表符号 -, *, +（保留内容）
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // > 引用
    .replace(/^[ \t]*>[ \t]?/gm, '')
    // 折叠多余空行
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
