export interface ToastItem {
  id: number;
  message: string;
}

/** Minimal bottom-right error toasts; the parent auto-dismisses by id. */
export default function Toasts({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="toasts" role="alert">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.message}
        </div>
      ))}
    </div>
  );
}
