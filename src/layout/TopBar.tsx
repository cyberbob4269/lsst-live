import ViewTabs from "./ViewTabs";
import type { ViewId } from "../App";

interface TopBarProps {
  active: ViewId;
  onSelect: (view: ViewId) => void;
}

/** App top bar: title on the left, view switcher tabs on the right. */
export default function TopBar({ active, onSelect }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <span className="topbar-dot" />
        LSST Live
      </div>
      <ViewTabs active={active} onSelect={onSelect} />
    </header>
  );
}
