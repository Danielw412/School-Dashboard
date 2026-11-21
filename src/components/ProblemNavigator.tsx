import { useEffect, useMemo, useRef, useState } from "react";

import { groupProblems, type NavigatorItem } from "../problem-navigation";

// A scroll-tracking table of contents: every problem is a chip under its section, the problems on
// screen are highlighted as the page scrolls, and a chip jumps to its problem.
export function ProblemNavigator({ items, label = "Problems" }: { items: NavigatorItem[]; label?: string }) {
  const groups = useMemo(() => groupProblems(items), [items]);
  const [visible, setVisible] = useState<Set<string>>(() => new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 60;
      const bottom = window.innerHeight;
      const onScreen = new Set<string>();
      let first: string | null = null;
      let startTop: number | null = null;
      let endBottom: number | null = null;
      for (const item of items) {
        const element = document.getElementById(item.id);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        startTop ??= rect.top;
        endBottom = rect.bottom;
        if (rect.bottom > top + 24 && rect.top < bottom - 24) {
          onScreen.add(item.id);
          first ??= item.id;
        }
      }
      setVisible((previous) => sameSet(previous, onScreen) ? previous : onScreen);
      setCurrent(first);
      if (startTop !== null && endBottom !== null) {
        const span = endBottom - startTop - (bottom - top);
        setProgress(span <= 0 ? 1 : Math.min(1, Math.max(0, (top - startTop) / span)));
      }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [items]);

  // Keep the current chip in view when the list itself scrolls (long lists, or the narrow strip).
  useEffect(() => {
    if (!current) return;
    const list = listRef.current;
    const chip = [...list?.querySelectorAll<HTMLElement>("[data-target]") ?? []].find((item) => item.dataset.target === current);
    if (!chip || !list) return;
    const chipBox = chip.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    if (chipBox.top < listBox.top || chipBox.bottom > listBox.bottom) list.scrollTop += chipBox.top - listBox.top - listBox.height / 2;
    if (chipBox.left < listBox.left || chipBox.right > listBox.right) list.scrollLeft += chipBox.left - listBox.left - listBox.width / 2;
  }, [current]);

  if (items.length < 2) return null;
  const index = current ? items.findIndex((item) => item.id === current) : -1;
  const jump = (id: string) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.scrollIntoView({ block: "start" });
    element.focus({ preventScroll: true });
  };

  return <nav className="problem-nav" aria-label={label}>
    <div className="problem-nav__head">
      <span>{label}</span>
      <span className="problem-nav__count">{index >= 0 ? `${index + 1} of ${items.length}` : items.length}</span>
    </div>
    <div className="problem-nav__track" aria-hidden><span style={{ transform: `scaleX(${progress})` }} /></div>
    <div className="problem-nav__list" ref={listRef}>
      {groups.map((group, groupIndex) => <div className="problem-nav__group" key={`${group.label ?? ""}-${groupIndex}`}>
        {group.label ? <span className="problem-nav__label" title={group.label}>{group.label}</span> : null}
        <div className="problem-nav__chips">
          {group.items.map((item) => <button
            type="button"
            key={item.id}
            data-target={item.id}
            className={`problem-nav__chip${visible.has(item.id) ? " is-visible" : ""}${current === item.id ? " is-current" : ""}${item.flagged ? " is-flagged" : ""}`}
            aria-current={current === item.id ? "location" : undefined}
            aria-label={`Problem ${item.number}`}
            title={item.preview ? `${item.number}: ${item.preview}` : item.number}
            onClick={() => jump(item.id)}
          >{item.short}</button>)}
        </div>
      </div>)}
    </div>
  </nav>;
}

function sameSet(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
