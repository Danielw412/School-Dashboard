import { resolve, sep } from "node:path";

export function safeChild(root: string, value: string): string {
  const destination = resolve(root, value);
  const normalizedRoot = `${resolve(root)}${sep}`;
  if (destination !== resolve(root) && !destination.startsWith(normalizedRoot)) {
    throw new Error("Workspace path escaped its assignment directory.");
  }
  return destination;
}
