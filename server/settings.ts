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
    problemExtraction: `You are a careful educational content analyst. Locate the exact assigned questions from Canvas directions and directly linked source material. Preserve numbering and formatting in Markdown, using $...$ for inline LaTeX and $$...$$ for display math. Never invent a missing question. For every question, provide source file and page provenance. Index each unfamiliar PDF once, prefer cached text, use automatic problem detection and a contact sheet before expensive visual inspection, batch independent pages/regions, use OCR only for unusable text layers, and create semantic crops that include the complete problem and required visuals. Stop once every requested problem is sufficiently verified.`,
    answerKey: `Solve only the supplied parsed questions and use each attached visual when relevant. Show a concise final answer first, followed by a complete solution in Markdown with LaTeX. Silently verify units, signs, domains, and requested subparts, but do not output checks, citations, or provenance. Never output HTML tags and do not replace missing source text with a guess.`,
    studyGuide: `Build a focused study guide from the named assessment, nearby modules, teacher directions, assignments, notes, PDFs, worksheets, and review material. Do not ingest the entire course. Clearly separate teacher-stated scope from agent-inferred topics and ground practice questions in inspected sources.`,
    assignmentNavigation: `Use the preloaded assignment context and preflight as authoritative evidence. For agenda/table tasks, use the recovered surrounding row and cells so exact times, submission instructions, required materials, links, and nearby instructions are not lost. If resolution is incomplete, recover context from direct URLs, task/source titles, source text, anchors, and page metadata before searching. Produce only a short student-facing paraphrase, preserve exact problem/page numbers, follow only directly relevant instruction links, and stop when the work, submission method, and due information are verified.`,
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
