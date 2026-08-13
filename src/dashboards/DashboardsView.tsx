// Dashboards view (Round 9B). Groups the vera-home pages served by the
// shared backend on 127.0.0.1:8765 under one top-level tab, with a slim
// internal sub-tab bar:
//
//   TOI Lab      — 3D exoplanet neighborhood map
//   Dashboard    — LSST Live ops dashboard (globe + alert feed)
//   Screensaver  — ambient view (preview; "Open fullscreen" opens the
//                  real thing in the system browser)
//
// Each page is embedded with the shared BackendFrame shell, so they all sit
// on the same backend lifecycle as Deep Space (one shared Rust manager —
// starting from any view serves them all).
//
// Keep-alive, two levels deep: the whole view stays mounted when the top
// tab switches, and every sub-view stays mounted when the sub-tab switches
// (iframes don't reload). Polling is gated on `visible && activeSub` so a
// hidden frame never polls.

import { useState } from "react";
import BackendFrame from "../deepspace/BackendFrame";

type SubId = "toi-lab" | "dashboard" | "screensaver";

const SUBS: Array<{ id: SubId; label: string }> = [
  { id: "toi-lab", label: "TOI Lab" },
  { id: "dashboard", label: "Dashboard" },
  { id: "screensaver", label: "Screensaver" },
];

export default function DashboardsView({ visible }: { visible: boolean }) {
  const [sub, setSub] = useState<SubId>("toi-lab");

  return (
    <div className="dash-wrap">
      <nav className="dash-subtabs" role="tablist">
        {SUBS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={sub === s.id}
            className={`dash-subtab${sub === s.id ? " is-active" : ""}`}
            onClick={() => setSub(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {/* Keep-alive sub-views: display:none keeps each iframe mounted. */}
      <div className={`view-keepalive${sub === "toi-lab" ? "" : " is-hidden"}`}>
        <BackendFrame
          title="TOI neighborhood lab"
          path="/ui/deep-space/toi-neighborhood-lab.html"
          visible={visible && sub === "toi-lab"}
        />
      </div>
      <div className={`view-keepalive${sub === "dashboard" ? "" : " is-hidden"}`}>
        <BackendFrame
          title="LSST Live dashboard"
          path="/ui/dashboard/index.html"
          visible={visible && sub === "dashboard"}
        />
      </div>
      <div className={`view-keepalive${sub === "screensaver" ? "" : " is-hidden"}`}>
        <BackendFrame
          title="Screensaver preview"
          path="/ui/screensaver/index.html"
          visible={visible && sub === "screensaver"}
          openLinkLabel="Open fullscreen"
        />
      </div>
    </div>
  );
}
