// Dashboards view — embeds vera-home lab pages via BackendFrame (local backend on
// 127.0.0.1:8765 when configured) or public GitHub Pages labs as fallback.

import { useState } from "react";
import BackendFrame from "../deepspace/BackendFrame";

type SubId =
  | "trappist-1"
  | "toi-lab"
  | "comet"
  | "asteroid"
  | "taurid"
  | "orbital-sky"
  | "dashboard"
  | "screensaver";

const SUBS: Array<{ id: SubId; label: string; path: string; title: string }> = [
  { id: "trappist-1", label: "TRAPPIST-1", path: "/ui/deep-space/trappist-1-lab.html", title: "TRAPPIST-1 lab" },
  { id: "toi-lab", label: "TOI Lab", path: "/ui/deep-space/toi-neighborhood-lab.html", title: "TOI neighborhood lab" },
  { id: "comet", label: "Comet", path: "/ui/deep-space/comet-lab.html", title: "Comet lab" },
  { id: "asteroid", label: "Asteroid", path: "/ui/deep-space/asteroid-lab.html", title: "Asteroid lab" },
  { id: "taurid", label: "Taurid", path: "/ui/deep-space/taurid-stream-lab.html", title: "Taurid stream lab" },
  { id: "orbital-sky", label: "Orbital sky", path: "/ui/deep-space/orbital-sky-lab.html", title: "Orbital sky lab" },
  { id: "dashboard", label: "Dashboard", path: "/ui/dashboard/index.html", title: "LSST Live dashboard" },
  { id: "screensaver", label: "Screensaver", path: "/ui/screensaver/index.html", title: "Screensaver preview" },
];

export default function DashboardsView({ visible }: { visible: boolean }) {
  const [sub, setSub] = useState<SubId>("trappist-1");

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

      {SUBS.map((s) => (
        <div key={s.id} className={`view-keepalive${sub === s.id ? "" : " is-hidden"}`}>
          <BackendFrame
            title={s.title}
            path={s.path}
            visible={visible && sub === s.id}
            openLinkLabel={s.id === "screensaver" ? "Open fullscreen" : undefined}
          />
        </div>
      ))}
    </div>
  );
}
