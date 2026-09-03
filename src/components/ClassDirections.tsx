import { Check, LoaderCircle, Save } from "lucide-react";
import { useMemo, useState } from "react";

import { schoolApi } from "../api";
import { classTone } from "../format";
import { usePolling } from "../hooks/usePolling";
import type { CourseDirections } from "../types";
import { EmptyState, ErrorNotice } from "./Status";

const featureFields: Array<{ key: keyof CourseDirections["directions"]; label: string }> = [
  { key: "directions", label: "Directions" },
  { key: "problemExtraction", label: "Problem extraction" },
  { key: "answerKey", label: "Answer key" },
  { key: "studyGuide", label: "Study guide" },
];

const emptyDirections = (): CourseDirections["directions"] => ({
  directions: "",
  problemExtraction: "",
  answerKey: "",
  studyGuide: "",
});

export function ClassDirections() {
  const coursesState = usePolling(schoolApi.taskCourses);
  const directionsState = usePolling(schoolApi.courseDirections);
  const [selectedId, setSelectedId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, CourseDirections["directions"]>>({});
  const [saving, setSaving] = useState(false);
  const [savedCourseId, setSavedCourseId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const courses = coursesState.data ?? [];
  const activeId = courses.some((course) => course.id === selectedId) ? selectedId : courses[0]?.id ?? "";
  const selectedCourse = courses.find((course) => course.id === activeId) ?? null;
  const savedDirections = useMemo(
    () => new Map((directionsState.data ?? []).map((entry) => [entry.courseId, entry])),
    [directionsState.data],
  );
  const persisted = savedDirections.get(activeId)?.directions ?? emptyDirections();
  const draft = drafts[activeId] ?? persisted;
  const dirty = featureFields.some(({ key }) => draft[key].trim() !== persisted[key]);

  const selectCourse = (courseId: string) => {
    setSelectedId(courseId);
    setSavedCourseId(null);
    setError(null);
  };

  const save = async () => {
    if (!selectedCourse) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await schoolApi.saveCourseDirections(selectedCourse.id, draft);
      const hasDirections = featureFields.some(({ key }) => saved.directions[key]);
      directionsState.setData(
        (directionsState.data ?? [])
          .filter((entry) => entry.courseId !== selectedCourse.id)
          .concat(hasDirections ? [saved] : []),
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[selectedCourse.id];
        return next;
      });
      setSavedCourseId(selectedCourse.id);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  const loading = coursesState.loading || directionsState.loading;
  const loadError = coursesState.error ?? directionsState.error;
  return (
    <div className="class-directions-settings">
      {loadError ? <ErrorNotice error={loadError} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {!loading && !loadError && courses.length === 0 ? <EmptyState title="No classes found" detail="Classes will appear here after Canvas Task Sync loads them." /> : null}
      {loading ? <div className="class-directions-skeleton"><span /><span /></div> : selectedCourse ? (
        <div className="class-directions-layout">
          <nav className="class-list" aria-label="Classes">
            <div className="class-list-heading">Your classes <span>{courses.length}</span></div>
            {courses.map((course) => {
              const saved = savedDirections.get(course.id)?.directions;
              const hasDirections = saved ? featureFields.some(({ key }) => saved[key]) : false;
              const courseDraft = drafts[course.id];
              const isDraft = courseDraft
                ? featureFields.some(({ key }) => courseDraft[key].trim() !== (saved?.[key] ?? ""))
                : false;
              return <button key={course.id} className={course.id === activeId ? "active" : ""} onClick={() => selectCourse(course.id)}>
                <span className={`course-mark tone-${classTone(course.id)}`}>{course.settings.prefix.slice(0, 3).toUpperCase()}</span>
                <span><strong>{course.settings.name}</strong><small>{isDraft ? "Unsaved changes" : hasDirections ? "Directions added" : "No directions yet"}</small></span>
              </button>;
            })}
          </nav>
          <div className="class-direction-editor">
            <header>
              <span className={`course-mark tone-${classTone(selectedCourse.id)}`}>{selectedCourse.settings.prefix.slice(0, 3).toUpperCase()}</span>
              <h2>{selectedCourse.settings.name}</h2>
            </header>
            <div className="class-direction-fields">
              {featureFields.map(({ key, label }) => (
                <label key={key} htmlFor={`class-directions-${key}`}>
                  <span>{label}</span>
                  <textarea
                    id={`class-directions-${key}`}
                    rows={7}
                    maxLength={20_000}
                    value={draft[key]}
                    onChange={(event) => {
                      setDrafts((current) => ({
                        ...current,
                        [activeId]: { ...(current[activeId] ?? persisted), [key]: event.target.value },
                      }));
                      setSavedCourseId(null);
                    }}
                  />
                </label>
              ))}
            </div>
            <footer>
              {savedCourseId === activeId && !dirty ? <span className="saved-directions"><Check size={14} />Saved</span> : null}
              <button className="primary-button" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Save directions
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
