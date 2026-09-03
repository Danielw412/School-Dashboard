import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Router } from "express";
import { z } from "zod";

import { APP_DATA_DIR } from "./env.js";

export const courseDirectionFeatures = ["directions", "problemExtraction", "answerKey", "studyGuide"] as const;
export type CourseDirectionFeature = (typeof courseDirectionFeatures)[number];

const courseIdSchema = z.string().min(1).max(200);
const directionSchema = z.string().max(20_000).trim();
export const courseDirectionsInputSchema = z.object({
  directions: z.object({
    directions: directionSchema,
    problemExtraction: directionSchema,
    answerKey: directionSchema,
    studyGuide: directionSchema,
  }),
});
const courseDirectionsSchema = z.object({
  courseId: courseIdSchema,
  directions: courseDirectionsInputSchema.shape.directions,
  updatedAt: z.string().datetime().nullable(),
});
export type CourseDirections = z.infer<typeof courseDirectionsSchema>;

export const emptyCourseDirections = (): CourseDirections["directions"] => ({
  directions: "",
  problemExtraction: "",
  answerKey: "",
  studyGuide: "",
});

export class CourseDirectionsStore {
  private pendingWrite: Promise<unknown> = Promise.resolve();

  constructor(private readonly path = join(APP_DATA_DIR, "course-directions.json")) {}

  async list(): Promise<CourseDirections[]> {
    try {
      return z.array(courseDirectionsSchema).parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(courseId: string): Promise<CourseDirections> {
    courseIdSchema.parse(courseId);
    return (await this.list()).find((entry) => entry.courseId === courseId)
      ?? { courseId, directions: emptyCourseDirections(), updatedAt: null };
  }

  save(courseId: string, input: unknown): Promise<CourseDirections> {
    courseIdSchema.parse(courseId);
    const { directions } = courseDirectionsInputSchema.parse(input);
    const save = this.pendingWrite.then(async () => {
      const entries = await this.list();
      const hasDirections = courseDirectionFeatures.some((feature) => directions[feature]);
      const entry: CourseDirections = { courseId, directions, updatedAt: new Date().toISOString() };
      const next = entries.filter((item) => item.courseId !== courseId);
      if (hasDirections) next.push(entry);
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        await rename(temporaryPath, this.path);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      return hasDirections ? entry : { courseId, directions: emptyCourseDirections(), updatedAt: null };
    });
    this.pendingWrite = save.catch(() => undefined);
    return save;
  }
}

export function courseDirectionsRouter(store: CourseDirectionsStore) {
  const router = Router();
  router.get("/", async (_request, response) => {
    response.json(await store.list());
  });
  router.put("/:courseId", async (request, response) => {
    response.json(await store.save(request.params.courseId, request.body));
  });
  return router;
}
