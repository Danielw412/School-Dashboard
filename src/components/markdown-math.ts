export function normalizeMathDelimiters(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment) => {
      if (segment.startsWith("`")) return segment;
      return segment
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => `$$\n${expression.trim()}\n$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`);
    })
    .join("");
}
