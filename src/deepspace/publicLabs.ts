/** Public hosted labs (GitHub Pages) — used when no local vera-home backend is configured. */
export const PUBLIC_LABS_INDEX =
  "https://cyberbob4269.github.io/lsst-live-site/labs/";

const PUBLIC_LABS_BASE = "https://cyberbob4269.github.io/lsst-live-site/labs";

/** Map vera-home UI paths to the matching public lab page. */
export const PUBLIC_LAB_BY_PATH: Record<string, string> = {
  "/ui/deep-space/trappist-1-lab.html": `${PUBLIC_LABS_BASE}/trappist-1-lab.html`,
  "/ui/deep-space/toi-neighborhood-lab.html": `${PUBLIC_LABS_BASE}/toi-neighborhood-lab.html`,
  "/ui/deep-space/comet-lab.html": `${PUBLIC_LABS_BASE}/comet-lab.html`,
  "/ui/deep-space/asteroid-lab.html": `${PUBLIC_LABS_BASE}/asteroid-lab.html`,
  "/ui/deep-space/taurid-stream-lab.html": `${PUBLIC_LABS_BASE}/taurid-stream-lab.html`,
  "/ui/deep-space/orbital-sky-lab.html": `${PUBLIC_LABS_BASE}/orbital-sky-lab.html`,
  "/ui/deep-space/index.html": PUBLIC_LABS_INDEX,
};

export function publicLabUrl(path: string): string | null {
  return PUBLIC_LAB_BY_PATH[path] ?? PUBLIC_LABS_INDEX;
}

export const FEATURED_PUBLIC_LABS = [
  { label: "All labs", url: PUBLIC_LABS_INDEX },
  { label: "TRAPPIST-1", url: PUBLIC_LAB_BY_PATH["/ui/deep-space/trappist-1-lab.html"] },
  { label: "TOI neighborhood", url: PUBLIC_LAB_BY_PATH["/ui/deep-space/toi-neighborhood-lab.html"] },
];
