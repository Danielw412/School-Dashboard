import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CourseDirectionsStore, emptyCourseDirections } from "./course-directions.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CourseDirectionsStore", () => {
  it("persists feature-specific directions for simultaneous class updates and removes empty records", async () => {
    const root = await mkdtemp(join(tmpdir(), "school-course-directions-"));
    temporaryDirectories.push(root);
    const path = join(root, "course-directions.json");
    const store = new CourseDirectionsStore(path);

    await Promise.all([
      store.save("physics", { directions: { ...emptyCourseDirections(), answerKey: "Use free-body diagrams first." } }),
      store.save("english", { directions: { ...emptyCourseDirections(), studyGuide: "Use MLA citations." } }),
    ]);

    expect((await store.get("physics")).directions).toEqual({ ...emptyCourseDirections(), answerKey: "Use free-body diagrams first." });
    expect((await store.get("english")).directions).toEqual({ ...emptyCourseDirections(), studyGuide: "Use MLA citations." });
    await store.save("physics", { directions: emptyCourseDirections() });
    expect(await store.get("physics")).toEqual({ courseId: "physics", directions: emptyCourseDirections(), updatedAt: null });
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(1);
  });
});
