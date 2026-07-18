// Extension → Monaco language / tree icon maps. Unknown extensions fall back
// to plaintext + a generic page icon.

const LANG_BY_EXT: Record<string, string> = {
  py: "python",
  md: "markdown",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "html",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  xml: "xml",
  sh: "shell",
  ps1: "powershell",
  sql: "sql",
  txt: "plaintext",
};

const ICON_BY_EXT: Record<string, string> = {
  py: "🐍",
  md: "📝",
  ts: "🔷",
  tsx: "🔷",
  js: "🟨",
  jsx: "🟨",
  json: "🧾",
  css: "🎨",
  html: "🌐",
  rs: "🦀",
  toml: "⚙️",
  yml: "⚙️",
  yaml: "⚙️",
  sh: "🐚",
  ps1: "🐚",
  sql: "🗄️",
};

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function languageFor(name: string): string {
  return LANG_BY_EXT[extOf(name)] ?? "plaintext";
}

export function iconFor(name: string): string {
  return ICON_BY_EXT[extOf(name)] ?? "📄";
}
