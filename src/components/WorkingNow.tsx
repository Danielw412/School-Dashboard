import { CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { Link } from "react-router-dom";

import type { ActiveAssignment } from "../active-work";
import { featureLabel, tabForFeature } from "../features";
import { classMarkText, classTone, formatElapsed } from "../format";
import { assistantName } from "../models";
import type { TrackedTask } from "../types";
import { RunMenu } from "./RunMenu";

// Live agent progress on the dashboard: each assignment an agent is working on, its steps, what it
// is doing this moment, and a way to stop it.
export function WorkingNow({ items, tasks, onChanged }: {
  items: ActiveAssignment[];
  tasks: Map<string, TrackedTask>;
  onChanged: () => void;
}) {
  if (!items.length) return null;
  const assistant = assistantName(items[0]!.run?.provider);
  return <section className="section working" aria-labelledby="working-heading">
    <div className="section-head">
      <h2 id="working-heading">Working now</h2>
      <p>{assistant} keeps going if you leave this page.</p>
    </div>
    <div className="surface">
      {items.map((item) => {
        const task = tasks.get(item.logicalId);
        const title = task?.display_title ?? item.taskTitle;
        const courseId = task?.course.id ?? item.courseName;
        const tab = item.feature ? tabForFeature(item.feature) : "directions";
        return <div className="row row--interactive working-row" key={item.logicalId}>
          <span className={`class-mark class-tone-${classTone(courseId)}`} aria-hidden>{classMarkText(task?.course.prefix ?? "", task?.course.name ?? item.courseName)}</span>
          <span className="working-row__main">
            <Link className="row-title stretched-link truncate" to={`/assignment/${encodeURIComponent(item.logicalId)}?tab=${tab}`}>{title}</Link>
            {item.workflow ? (
              <ol className="steps-inline" aria-label={`Steps for ${title}`}>
                {item.workflow.steps.map((step, index) => (
                  <li className={step.status} key={`${step.feature}-${index}`}>
                    {step.status === "completed" ? <CheckIcon size={12} weight="bold" aria-hidden /> : step.status === "running" ? <CircleNotchIcon className="spin" size={12} weight="bold" aria-hidden /> : null}
                    {featureLabel(step.feature)}
                    {step.status === "completed" ? <span className="sr-only"> (done)</span> : step.status === "running" ? <span className="sr-only"> (running)</span> : null}
                  </li>
                ))}
              </ol>
            ) : null}
            {item.workflow && item.workflow.currentStep !== null ? (
              <span className="working-row__step">
                Step {item.workflow.currentStep + 1} of {item.workflow.steps.length}: {featureLabel(item.workflow.steps[item.workflow.currentStep]!.feature)}
              </span>
            ) : null}
            {!item.workflow ? <span className="row-meta">{item.feature ? featureLabel(item.feature) : "Starting"}, {task?.course.name ?? item.courseName}</span> : null}
          </span>
          <span className="working-row__activity" title={item.current}>
            <CircleNotchIcon className="spin tone-info" size={14} weight="bold" aria-hidden />
            <span className="truncate">{item.current}</span>
            {item.elapsedMs !== null ? <span className="subtle num">{formatElapsed(item.elapsedMs)}</span> : null}
          </span>
          <span className="row-actions">
            <RunMenu logicalId={item.logicalId} title={title} active={item} onChanged={onChanged} />
          </span>
        </div>;
      })}
    </div>
  </section>;
}
