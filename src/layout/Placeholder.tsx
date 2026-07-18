interface PlaceholderProps {
  title: string;
  tag: string;
  description: string;
}

/** Centered placeholder card for views that land in later phases. */
export default function Placeholder({ title, tag, description }: PlaceholderProps) {
  return (
    <div className="placeholder-wrap">
      <div className="placeholder-card">
        <span className="placeholder-tag">{tag}</span>
        <h1 className="placeholder-title">{title}</h1>
        <p className="placeholder-desc muted">{description}</p>
      </div>
    </div>
  );
}
