import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImageOff,
  LoaderCircle,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

import { workspaceFileUrl } from "../api";
import type { SourceDocument } from "../types";

export type SourcePageRequest = { documentId: string; page: number; label: string };

type Frame = { left: number; top: number; width: number; height: number };
type View = { scale: number; x: number; y: number; fitWidth: number };
type Size = { width: number; height: number };

const MIN_WIDTH = 320;
const MIN_HEIGHT = 260;
const MAX_ZOOM = 4;
const COMPACT_QUERY = "(max-width: 660px)";

// Where the student last left the window, so reopening it does not jump back.
let lastFrame: Frame | null = null;

// A non-modal floating window over the workspace: the problem stays readable beside it.
export function SourcePageViewer({
  documents,
  workspaceId,
  request,
  onNavigate,
  onClose,
}: {
  documents: SourceDocument[];
  workspaceId: string | null;
  request: SourcePageRequest;
  onNavigate: (page: number) => void;
  onClose: () => void;
}) {
  const source = documents.find((item) => item.id === request.documentId);
  const pages = [...(source?.pages ?? [])].sort((left, right) => left.page - right.page);
  const index = pages.findIndex((item) => item.page === request.page);
  const current = index >= 0 ? pages[index] : undefined;
  const src = workspaceId && current ? workspaceFileUrl(workspaceId, current.path) : null;
  const pageKey = `${request.documentId}:${request.page}`;
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false);

  const [frame, setFrame] = useState<Frame>(() => clampFrame(lastFrame ?? defaultFrame()));
  const [natural, setNatural] = useState<{ key: string; size: Size } | null>(null);
  const [viewState, setViewState] = useState<{ key: string; view: View } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; view: View }
    | { kind: "pinch"; distance: number; midX: number; midY: number; view: View }
    | null
  >(null);
  const frameGesture = useRef<{ kind: "move" | "resize"; startX: number; startY: number; frame: Frame } | null>(null);
  const pendingFrame = useRef<Frame | null>(null);

  const size = natural?.key === pageKey ? natural.size : null;
  const view = viewState?.key === pageKey ? viewState.view : null;
  const failed = src !== null && failedSrc === src;

  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const keepOnScreen = () => setFrame((previous) => clampFrame(previous));
    window.addEventListener("resize", keepOnScreen);
    return () => window.removeEventListener("resize", keepOnScreen);
  }, []);

  const stageBox = (): Size => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { width: rect?.width || 1, height: rect?.height || 1 };
  };

  const fitView = (image: Size, mode: "width" | "page"): View => {
    const stage = stageBox();
    const fitWidth = stage.width / image.width;
    const scale = mode === "width" ? fitWidth : Math.min(fitWidth, stage.height / image.height);
    return { scale, x: (stage.width - image.width * scale) / 2, y: mode === "width" ? 0 : (stage.height - image.height * scale) / 2, fitWidth };
  };

  // Keep at least a strip of the page on screen so it can always be dragged back.
  const clampView = (next: View, image: Size): View => {
    const stage = stageBox();
    const margin = 48;
    const width = image.width * next.scale;
    const height = image.height * next.scale;
    return {
      ...next,
      x: Math.min(stage.width - margin, Math.max(margin - width, next.x)),
      y: Math.min(stage.height - margin, Math.max(margin - height, next.y)),
    };
  };

  const zoomAround = (base: View, image: Size, scale: number, pointX: number, pointY: number): View => {
    const bounded = Math.min(base.fitWidth * MAX_ZOOM, Math.max(base.fitWidth * 0.4, scale));
    return clampView({
      ...base,
      scale: bounded,
      x: pointX - (pointX - base.x) * (bounded / base.scale),
      y: pointY - (pointY - base.y) * (bounded / base.scale),
    }, image);
  };

  const updateView = (next: (current: View, image: Size) => View) => {
    if (!size) return;
    setViewState((previous) => previous?.key === pageKey ? { key: pageKey, view: next(previous.view, size) } : previous);
  };

  const zoomBy = (factor: number) => {
    const stage = stageBox();
    updateView((current, image) => zoomAround(current, image, current.scale * factor, stage.width / 2, stage.height / 2));
  };

  const fit = () => {
    if (size) setViewState({ key: pageKey, view: fitView(size, "width") });
  };

  // React registers wheel listeners as passive; zooming has to cancel the page scroll.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !size) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015));
      setViewState((previous) => previous?.key === pageKey
        ? { key: pageKey, view: zoomAround(previous.view, size, previous.view.scale * factor, event.clientX - rect.left, event.clientY - rect.top) }
        : previous);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  });

  const stagePoint = (event: PointerEvent) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onStagePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!view || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, stagePoint(event));
    const points = [...pointers.current.values()];
    if (points.length === 1) {
      gesture.current = { kind: "pan", startX: points[0]!.x, startY: points[0]!.y, view };
      setPanning(true);
    } else if (points.length === 2) {
      gesture.current = {
        kind: "pinch",
        distance: Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) || 1,
        midX: (points[0]!.x + points[1]!.x) / 2,
        midY: (points[0]!.y + points[1]!.y) / 2,
        view,
      };
    }
  };

  const onStagePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !size) return;
    pointers.current.set(event.pointerId, stagePoint(event));
    const points = [...pointers.current.values()];
    const active = gesture.current;
    if (active?.kind === "pan" && points.length === 1) {
      const next = clampView({ ...active.view, x: active.view.x + points[0]!.x - active.startX, y: active.view.y + points[0]!.y - active.startY }, size);
      setViewState({ key: pageKey, view: next });
    } else if (active?.kind === "pinch" && points.length === 2) {
      const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
      setViewState({ key: pageKey, view: zoomAround(active.view, size, active.view.scale * (distance / active.distance), active.midX, active.midY) });
    }
  };

  const onStagePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    const remaining = [...pointers.current.values()];
    // Lifting one finger of a pinch continues as a pan from where it is.
    gesture.current = remaining.length === 1 && view
      ? { kind: "pan", startX: remaining[0]!.x, startY: remaining[0]!.y, view }
      : null;
    setPanning(remaining.length > 0);
  };

  const onStageDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!view || !size) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const zoomedIn = view.scale > view.fitWidth * 1.8;
    setViewState({
      key: pageKey,
      view: zoomedIn ? fitView(size, "width") : zoomAround(view, size, view.fitWidth * 2.5, event.clientX - rect.left, event.clientY - rect.top),
    });
  };

  const beginFrameGesture = (kind: "move" | "resize", event: PointerEvent<HTMLElement>) => {
    if (compact || event.button !== 0 || (kind === "move" && (event.target as HTMLElement).closest("button, a"))) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    frameGesture.current = { kind, startX: event.clientX, startY: event.clientY, frame };
  };
  const onBarPointerDown = (event: PointerEvent<HTMLElement>) => beginFrameGesture("move", event);
  const onResizePointerDown = (event: PointerEvent<HTMLElement>) => beginFrameGesture("resize", event);

  const onFramePointerMove = (event: PointerEvent<HTMLElement>) => {
    const active = frameGesture.current;
    if (!active) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    const next = clampFrame(active.kind === "move"
      ? { ...active.frame, left: active.frame.left + dx, top: active.frame.top + dy }
      : {
        ...active.frame,
        // Grow toward the screen edge; never push the window's corner back.
        width: Math.min(active.frame.width + dx, window.innerWidth - active.frame.left - 8),
        height: Math.min(active.frame.height + dy, window.innerHeight - active.frame.top - 8),
      });
    pendingFrame.current = next;
    setFrame(next);
  };

  const endFrameGesture = () => {
    if (pendingFrame.current) lastFrame = pendingFrame.current;
    frameGesture.current = null;
    pendingFrame.current = null;
  };

  const go = (offset: number) => {
    const target = pages[index + offset];
    if (target) onNavigate(target.page);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("a")) return;
    const pan = (dx: number, dy: number) => updateView((currentView, image) => clampView({ ...currentView, x: currentView.x + dx, y: currentView.y + dy }, image));
    const actions: Record<string, () => void> = {
      Escape: onClose,
      "+": () => zoomBy(1.25),
      "=": () => zoomBy(1.25),
      "-": () => zoomBy(0.8),
      "0": fit,
      PageDown: () => go(1),
      PageUp: () => go(-1),
      ArrowLeft: () => pan(80, 0),
      ArrowRight: () => pan(-80, 0),
      ArrowUp: () => pan(0, 80),
      ArrowDown: () => pan(0, -80),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const zoomPercent = view ? Math.round((view.scale / view.fitWidth) * 100) : 100;
  const titleId = "source-page-viewer-title";

  return (
    <section
      ref={containerRef}
      className={`page-viewer${compact ? " compact" : ""}`}
      style={compact ? undefined : { left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header
        className="page-viewer-bar"
        onPointerDown={onBarPointerDown}
        onPointerMove={onFramePointerMove}
        onPointerUp={endFrameGesture}
        onPointerCancel={endFrameGesture}
      >
        <div className="page-viewer-title">
          <strong id={titleId}>{request.label}</strong>
          <span>Page {request.page}{source ? ` of ${source.pageCount}` : ""} · {source?.name ?? "Source file"}</span>
        </div>
        <div className="page-viewer-tools">
          <div className="page-viewer-group">
            <button className="icon-button" onClick={() => go(-1)} disabled={index <= 0} aria-label="Previous page" title="Previous page (Page Up)"><ChevronLeft size={17} /></button>
            <button className="icon-button" onClick={() => go(1)} disabled={index < 0 || index >= pages.length - 1} aria-label="Next page" title="Next page (Page Down)"><ChevronRight size={17} /></button>
          </div>
          <div className="page-viewer-group">
            <button className="icon-button" onClick={() => zoomBy(0.8)} disabled={!view} aria-label="Zoom out" title="Zoom out (−)"><ZoomOut size={16} /></button>
            <button className="page-viewer-zoom" onClick={fit} disabled={!view} aria-label="Fit page width" title="Fit width (0)">{zoomPercent}%</button>
            <button className="icon-button" onClick={() => zoomBy(1.25)} disabled={!view} aria-label="Zoom in" title="Zoom in (+)"><ZoomIn size={16} /></button>
            <button className="icon-button" onClick={() => size && setViewState({ key: pageKey, view: fitView(size, "page") })} disabled={!view} aria-label="Show whole page" title="Show whole page"><Scan size={16} /></button>
          </div>
          {src && <a className="icon-button" href={src} target="_blank" rel="noreferrer" aria-label="Open page image in a new tab" title="Open in a new tab"><ExternalLink size={15} /></a>}
          <button className="icon-button" onClick={onClose} aria-label="Close page viewer" title="Close (Esc)"><X size={17} /></button>
        </div>
      </header>
      <div
        ref={stageRef}
        className={`page-viewer-stage${panning ? " panning" : ""}`}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerEnd}
        onPointerCancel={onStagePointerEnd}
        onDoubleClick={onStageDoubleClick}
      >
        {src && !failed && <img
          key={src}
          className="page-viewer-image"
          src={src}
          alt={`${source?.name ?? "Source"} page ${request.page}`}
          draggable={false}
          style={view && size
            ? { width: size.width, height: size.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }
            : { opacity: 0 }}
          onLoad={(event) => {
            const image = { width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 };
            setNatural({ key: pageKey, size: image });
            setViewState({ key: pageKey, view: fitView(image, "width") });
          }}
          onError={() => setFailedSrc(src)}
        />}
        {src && !failed && !view && <div className="page-viewer-status"><LoaderCircle className="spin" size={18} />Loading page</div>}
        {(!src || failed) && <div className="page-viewer-status" role="status"><ImageOff size={18} />This page image is unavailable. Extract the problems again to restore it.</div>}
      </div>
      {!compact && <span
        className="page-viewer-resize"
        aria-hidden="true"
        onPointerDown={onResizePointerDown}
        onPointerMove={onFramePointerMove}
        onPointerUp={endFrameGesture}
        onPointerCancel={endFrameGesture}
      />}
    </section>
  );
}

function defaultFrame(): Frame {
  const width = Math.min(620, Math.max(MIN_WIDTH, window.innerWidth * 0.44));
  const height = Math.max(MIN_HEIGHT, window.innerHeight - 110);
  return { left: window.innerWidth - width - 24, top: 86, width, height };
}

// Keep the whole window, including its resize corner, inside the viewport.
function clampFrame(frame: Frame): Frame {
  const width = Math.min(Math.max(MIN_WIDTH, frame.width), Math.max(MIN_WIDTH, window.innerWidth - 16));
  const height = Math.min(Math.max(MIN_HEIGHT, frame.height), Math.max(MIN_HEIGHT, window.innerHeight - 16));
  return {
    width,
    height,
    left: Math.min(Math.max(8, frame.left), Math.max(8, window.innerWidth - width - 8)),
    top: Math.min(Math.max(8, frame.top), Math.max(8, window.innerHeight - height - 8)),
  };
}

function subscribeCompact(callback: () => void) {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener("change", callback);
  return () => query?.removeEventListener("change", callback);
}

function isCompact() {
  return window.matchMedia?.(COMPACT_QUERY).matches ?? false;
}
