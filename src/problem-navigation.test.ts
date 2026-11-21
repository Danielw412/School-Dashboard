import { describe, expect, it } from "vitest";

import { groupProblems, problemPreview } from "./problem-navigation";

describe("problem navigation", () => {
  it("groups consecutive problems by section and keeps plain numbers whole", () => {
    const groups = groupProblems([
      { id: "a", number: "Kinematics 8.1–8.2 #1" },
      { id: "b", number: "Kinematics 8.1–8.2 #10" },
      { id: "c", number: "Torque 9.4 #34" },
      { id: "d", number: "19" },
      { id: "e", number: "20" },
    ]);
    expect(groups.map((group) => [group.label, group.items.map((item) => item.short)])).toEqual([
      ["Kinematics 8.1–8.2", ["1", "10"]],
      ["Torque 9.4", ["34"]],
      [null, ["19", "20"]],
    ]);
  });

  it("previews problem text without Markdown or math delimiters", () => {
    expect(problemPreview("**1.** Find $v_0$ when\n\n$$x = 3$$")).toBe("1. Find v_0 when x = 3");
  });
});
