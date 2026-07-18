import type { ViewId } from "../App";

interface ViewTabsProps {
  active: ViewId;
  onSelect: (view: ViewId) => void;
}

const TABS: Array<{ id: ViewId; label: string }> = [
  { id: "ide", label: "IDE" },
  { id: "deep-space", label: "Deep Space" },
  { id: "social", label: "Social" },
  { id: "settings", label: "Settings" },
];

/** View switcher tabs for the top bar. */
export default function ViewTabs({ active, onSelect }: ViewTabsProps) {
  return (
    <nav className="view-tabs" role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={`view-tab${active === tab.id ? " is-active" : ""}`}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
