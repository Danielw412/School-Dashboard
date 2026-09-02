import { useState } from "react";

import type { ProblemExtraction } from "../types";

type Visual = NonNullable<ProblemExtraction["problems"][number]["visual"]>;

export function ProblemVisual({ visual, workspaceId }: { visual: Visual; workspaceId: string | null }) {
  const src = workspaceId
    ? `/workspace-files/${encodeURIComponent(workspaceId)}/${visual.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`
    : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return <figure>
    {src && failedSrc !== src
      ? <img src={src} alt={visual.caption} onError={() => setFailedSrc(src)} />
      : <div className="notice amber" role="status">This figure is unavailable. Use View sources to open the original, or Extract again to restore it.</div>}
    <figcaption>{visual.caption} · page {visual.page}</figcaption>
  </figure>;
}
