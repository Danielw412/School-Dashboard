export type NavigatorItem = {
  // The DOM id of the element this item scrolls to.
  id: string;
  // The problem's full number, such as "Kinematics 8.1–8.2 #10" or "19".
  number: string;
  // A short preview shown on hover.
  preview?: string;
  flagged?: boolean;
};

export type ProblemGroup = { label: string | null; items: Array<NavigatorItem & { short: string }> };

// "Kinematics 8.1–8.2 #10" reads as section "Kinematics 8.1–8.2", problem "10"; plain numbers stay
// whole. Consecutive problems from one section share a heading.
export function groupProblems(items: NavigatorItem[]): ProblemGroup[] {
  const groups: ProblemGroup[] = [];
  for (const item of items) {
    const match = item.number.match(/^(.*\S)\s*#\s*(\S.*)$/);
    const label = match ? match[1]!.replace(/^Problem\s+/i, "") : null;
    const short = match ? match[2]! : item.number;
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push({ ...item, short });
    else groups.push({ label, items: [{ ...item, short }] });
  }
  return groups;
}

// The problem text's first line, without Markdown or LaTeX noise, for a hover preview.
export function problemPreview(markdown: string, length = 90): string {
  const text = markdown
    .replace(/\$\$?([^$]*)\$\$?/g, "$1")
    .replace(/[*`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}
