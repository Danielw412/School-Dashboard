import { ArrowSquareOutIcon, ChalkboardTeacherIcon, CheckIcon, FloppyDiskIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { schoolApi } from "../api";
import { Button, EmptyState, ErrorNotice, Field, LinkButton, PageHeader, SkeletonRows } from "../components/ui";
import { classMarkText, classTone } from "../format";
import { usePolling } from "../hooks/usePolling";
import { useTaskSyncUrl } from "../shell-context";
import { taskSyncPages } from "../task-sync-links";
import { useToast } from "../toast";
import type { CourseDirections } from "../types";

type Directions = CourseDirections["directions"];

const fields: Array<{ key: keyof Directions; label: string; help: string; placeholder: string }> = [
  {
    key: "directions",
    label: "Directions",
    help: "Used when reading what an assignment asks for.",
    placeholder: "For example: homework is the odd-numbered problems unless the agenda says otherwise.",
  },
  {
    key: "problemExtraction",
    label: "Assigned problems",
    help: "Used when finding the exact questions.",
    placeholder: "For example: keep section headings, and skip worked examples.",
  },
  {
    key: "answerKey",
    label: "Answer key",
    help: "Used when solving the extracted problems.",
    placeholder: "For example: use free-body diagrams and three significant figures.",
  },
  {
    key: "studyGuide",
    label: "Study guide",
    help: "Used when building a guide for a test or quiz.",
    placeholder: "For example: unit tests always include one free-response question.",
  },
];

const emptyDirections = (): Directions => ({ directions: "", problemExtraction: "", answerKey: "", studyGuide: "" });

const differs = (draft: Directions, saved: Directions) => fields.some(({ key }) => draft[key].trim() !== saved[key]);

export function ClassesPage() {
  const coursesState = usePolling(schoolApi.taskCourses);
  const directionsState = usePolling(schoolApi.courseDirections);
  const [searchParams, setSearchParams] = useSearchParams();
  const [drafts, setDrafts] = useState<Record<string, Directions>>({});
  const [saving, setSaving] = useState(false);
  const [savedCourseId, setSavedCourseId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const taskSyncUrl = useTaskSyncUrl();

  const courses = useMemo(
    () => [...(coursesState.data ?? [])].sort((left, right) => left.settings.name.localeCompare(right.settings.name)),
    [coursesState.data],
  );
  const requested = searchParams.get("class") ?? "";
  const activeId = courses.some((course) => course.id === requested) ? requested : courses[0]?.id ?? "";
  const course = courses.find((item) => item.id === activeId) ?? null;
  const savedDirections = useMemo(
    () => new Map((directionsState.data ?? []).map((entry) => [entry.courseId, entry.directions])),
    [directionsState.data],
  );
  const persisted = savedDirections.get(activeId) ?? emptyDirections();
  const draft = drafts[activeId] ?? persisted;
  const dirty = differs(draft, persisted);
  const written = fields.filter(({ key }) => persisted[key]).length;

  const select = (courseId: string) => {
    setSearchParams({ class: courseId }, { replace: true });
    setSavedCourseId(null);
    setError(null);
  };

  const discard = () => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[activeId];
      return next;
    });
  };

  const save = async () => {
    if (!course) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await schoolApi.saveCourseDirections(course.id, draft);
      const hasDirections = fields.some(({ key }) => saved.directions[key]);
      directionsState.setData(
        (directionsState.data ?? [])
          .filter((entry) => entry.courseId !== course.id)
          .concat(hasDirections ? [saved] : []),
      );
      discard();
      setSavedCourseId(course.id);
      toast(`Instructions saved for ${course.settings.name}.`, "success");
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  const loading = coursesState.loading || directionsState.loading;
  const loadError = coursesState.error ?? directionsState.error;

  return (
    <div className="page--classes">
      <PageHeader
        title="Classes"
        description="Instructions for the agents about each class. They're added to every run for that class, on top of the base prompts in Settings."
      />
      {loadError ? <ErrorNotice error={loadError} title="Classes could not load" /> : null}
      {loading ? <SkeletonRows rows={4} label="Loading classes" /> : null}
      {!loading && !loadError && courses.length === 0 ? (
        <div className="surface">
          <EmptyState
            icon={ChalkboardTeacherIcon}
            title="No classes yet"
            body="Classes appear here once Canvas Task Sync is tracking them."
            action={taskSyncUrl ? <LinkButton href={taskSyncPages.home(taskSyncUrl)} icon={ArrowSquareOutIcon}>Open Task Sync</LinkButton> : undefined}
          />
        </div>
      ) : null}
      {!loading && course ? (
        <div className="classes-layout">
          <nav className="class-list" aria-label="Classes">
            {courses.map((item) => {
              const saved = savedDirections.get(item.id);
              const count = saved ? fields.filter(({ key }) => saved[key]).length : 0;
              const itemDraft = drafts[item.id];
              const unsaved = itemDraft ? differs(itemDraft, saved ?? emptyDirections()) : false;
              return <button
                type="button"
                key={item.id}
                className={`class-list__item${item.id === activeId ? " is-active" : ""}`}
                aria-current={item.id === activeId ? "true" : undefined}
                onClick={() => select(item.id)}
              >
                <span className={`class-mark class-tone-${classTone(item.id)}`} aria-hidden>{classMarkText(item.settings.prefix, item.settings.name)}</span>
                <span className="class-list__text">
                  <strong className="truncate">{item.settings.name}</strong>
                  <small className={unsaved ? "is-dirty" : undefined}>{unsaved ? "Unsaved changes" : count ? `${count} ${count === 1 ? "instruction" : "instructions"}` : "No instructions yet"}</small>
                </span>
              </button>;
            })}
          </nav>

          <div className="editor">
            <div className="editor-head">
              <div className="editor-head__text">
                <span className={`class-mark class-mark--lg class-tone-${classTone(course.id)}`} aria-hidden>{classMarkText(course.settings.prefix, course.settings.name)}</span>
                <div>
                  <h2>{course.settings.name}</h2>
                  <span className="editor-head__meta">
                    {written ? `Instructions for ${written} of ${fields.length} features.` : "No instructions yet, so agents use their defaults."}
                    {" "}<Link className="text-link" to={`/?class=${encodeURIComponent(course.id)}`}>See assignments</Link>
                  </span>
                </div>
              </div>
              {taskSyncUrl ? <LinkButton size="sm" href={taskSyncPages.course(taskSyncUrl, course.id)} icon={ArrowSquareOutIcon}>Sync settings</LinkButton> : null}
            </div>

            {error ? <ErrorNotice error={error} title="The instructions weren't saved" /> : null}

            <section className="form-section">
              <div className="form-section__intro">
                <h3>Instructions for agents</h3>
                <p>Write them as you would for a tutor: how this teacher assigns work, formats problems, or grades. Leave a field empty to keep the default behavior.</p>
              </div>
              <div className="form-section__fields">
                {fields.map(({ key, label, help, placeholder }) => (
                  <Field key={key} label={label} help={help}>
                    <textarea
                      className="control"
                      rows={4}
                      maxLength={20_000}
                      placeholder={placeholder}
                      value={draft[key]}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDrafts((current) => ({ ...current, [activeId]: { ...(current[activeId] ?? persisted), [key]: value } }));
                        setSavedCourseId(null);
                      }}
                    />
                  </Field>
                ))}
              </div>
            </section>

            <div className={`save-bar${dirty ? " is-dirty" : ""}`}>
              <span className="save-bar__status" role="status">
                {dirty ? "Unsaved changes" : savedCourseId === activeId ? <><CheckIcon className="tone-success" size={15} weight="bold" aria-hidden />Saved</> : "Changes apply to the next run for this class."}
              </span>
              <div className="save-bar__actions">
                {dirty ? <Button variant="ghost" disabled={saving} onClick={discard}>Discard</Button> : null}
                <Button icon={FloppyDiskIcon} loading={saving} disabled={!dirty} onClick={() => void save()}>Save instructions</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
