export function normalizeMathDelimiters(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment) => {
      if (segment.startsWith("`")) return segment;
      return segment
        .replace(/<details\b[^>]*>\s*/gi, "")
        .replace(/\s*<\/details>/gi, "")
        .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>\s*/gi, "")
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, text: string) =>
          `${"#".repeat(Number(level))} ${text.trim()}\n\n`,
        )
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?p\b[^>]*>/gi, "\n\n")
        .replace(/\\vec\s+([A-Za-z])/g, "\\vec{$1}")
        .replace(/\\hat\s*\\(imath|jmath)/g, "\\hat{\\$1}")
        .replace(/\\hat\s+([A-Za-z])/g, "\\hat{$1}")
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => `$$\n${expression.trim()}\n$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`);
    })
    .join("");
}
