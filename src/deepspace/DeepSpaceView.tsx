// Deep Space view (Phase 4). Embeds the vera-home deep-space dashboard —
// a same-origin web app on http://127.0.0.1:8765 — via the shared
// BackendFrame shell, which manages the backend lifecycle through the
// vera_backend_* commands. Behavior unchanged since Round 9B; the reusable
// shell (control bar, starting splash, error card, polling) now lives in
// ./BackendFrame so the Dashboards views reuse it too.

import { openUrl } from "@tauri-apps/plugin-opener";
import BackendFrame from "./BackendFrame";

const DASHBOARD_URL = "http://127.0.0.1:8765/ui/dashboard/index.html";

export default function DeepSpaceView({ visible }: { visible: boolean }) {
  return (
    <BackendFrame
      title="Deep Space dashboard"
      path="/ui/deep-space/index.html"
      visible={visible}
      footerExtra={
        <button className="ds-link" onClick={() => void openUrl(DASHBOARD_URL)}>
          Plain dashboard
        </button>
      }
    />
  );
}
