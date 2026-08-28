import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { env, SETTINGS_PATH } from "./env.js";

export const modelSchema = z.enum(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const settingsSchema = z.object({
  version: z.literal(1),
  defaultModel: modelSchema,
  featureModels: z.object({
    problemExtraction: modelSchema,
    answerKey: modelSchema,
    studyGuide: modelSchema,
    assignmentNavigation: modelSchema,
  }),
  reasoningEffort: reasoningEffortSchema,
  prompts: z.object({
    problemExtraction: z.string().min(20),
    answerKey: z.string().min(20),
    studyGuide: z.string().min(20),
    assignmentNavigation: z.string().min(20),
  }),
  testQuestionPredictor: z.object({
    enabled: z.boolean(),
  }),
  connections: z.object({
    taskSyncApiBase: z.string().url(),
    canvasBaseUrl: z.string(),
  }),
  cache: z.object({
    ttlMinutes: z.number().int().min(1).max(1440),
    maxMegabytes: z.number().int().min(64).max(8192),
    workspaceRetentionHours: z.number().int().min(1).max(168),
  }),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export const defaultSettings: AppSettings = {
  version: 1,
  defaultModel: "gpt-5.6-luna",
  featureModels: {
    problemExtraction: "gpt-5.6-luna",
    answerKey: "gpt-5.6-luna",
    studyGuide: "gpt-5.6-luna",
    assignmentNavigation: "gpt-5.6-luna",
  },
  reasoningEffort: "high",
  prompts: {
    problemExtraction: `You are a careful educational content analyst. Locate the exact assigned questions from Canvas directions and linked source material. Preserve numbering and formatting in Markdown with LaTeX. Never invent a missing question. For every question, provide source file and page provenance. When a question depends on a visual, render its page and crop the relevant figure when reliable; otherwise attach the full page.`,
    answerKey: `Solve only the supplied extracted problems. Show a concise final answer first, followed by a complete expandable solution in Markdown with LaTeX. Check units, signs, domains, and requested subparts. Cite the extracted problem provenance and do not replace missing source text with a guess.`,
    studyGuide: `Build a focused study guide from the named assessment, nearby modules, teacher directions, assignments, notes, PDFs, worksheets, and review material. Do not ingest the entire course. Clearly separate teacher-stated scope from agent-inferred topics and ground practice questions in inspected sources.`,
    assignmentNavigation: `Investigate the selected assignment deterministically first. Read its Canvas directions, submission requirements, containing module, linked pages, files, and same-origin Canvas resources. Follow only links relevant to the assignment. Do not claim access to an external platform unless its content was actually available.`,
  },
  testQuestionPredictor: { enabled: false },
  connections: {
    taskSyncApiBase: env.taskSyncApiBase,
    canvasBaseUrl: env.canvasBaseUrl,
  },
  cache: {
    ttlMinutes: Number.isFinite(env.cacheTtlMinutes) ? env.cacheTtlMinutes : 30,
    maxMegabytes: Number.isFinite(env.cacheMaxMb) ? env.cacheMaxMb : 512,
    workspaceRetentionHours: 24,
  },
};

export class SettingsStore {
  async get(): Promise<AppSettings> {
    try {
      const raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as unknown;
      return settingsSchema.parse(raw);
    } catch {
      return structuredClone(defaultSettings);
    }
  }

  async save(input: unknown): Promise<AppSettings> {
    const settings = settingsSchema.parse(input);
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    const temporaryPath = `${SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporaryPath, SETTINGS_PATH);
    return settings;
  }

  defaults(): AppSettings {
    return structuredClone(defaultSettings);
  }
}
