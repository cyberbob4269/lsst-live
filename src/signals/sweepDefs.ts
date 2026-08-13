// Curated X-intelligence sweep definitions (Round 9A).
//
// The five topic bundles (names + query terms) are LIFTED from the vera-home
// Python scanner `scripts/social/cosmic_x_space_search.py` (TOPICS dict) —
// READ-ONLY source, do not edit that repo from here. There the strings are
// literal X API v2 recent-search queries (max 512 chars); here they are fed
// to Grok as search-term hints alongside its first-party `x_search` tool
// (see xintel.ts), so the X-specific operators (-is:retweet, lang:en) act as
// guidance, not syntax.
//
// The sixth bundle is the watchlist from vera-home `data/social/x_watchlist.json`
// (account usernames only) — also enforced server-side via `handles`
// (x_search `allowed_x_handles`, max 20).

export interface SweepDef {
  /** Stable id, also used as the topic key in results. */
  id: string;
  /** Human label for the card header. */
  label: string;
  /** Query terms / account list handed to Grok as search hints. */
  queryTerms: string;
  /** Optional x_search `allowed_x_handles` restriction (bare usernames, max 20). */
  handles?: string[];
}

export const SWEEP_DEFS: SweepDef[] = [
  {
    id: "solar_system",
    label: "Solar System",
    queryTerms:
      '(Mars OR Jupiter OR Saturn OR comet OR asteroid OR "close approach" OR ' +
      '"solar system") (NASA OR ESA OR JPL OR astronom OR observatory OR space) ' +
      "-is:retweet lang:en -crypto",
  },
  {
    id: "missions",
    label: "Missions & Launches",
    queryTerms:
      '("Falcon Heavy" OR Falcon OR Starship OR SpaceX OR Artemis OR ' +
      '"NASA launch" OR "ESA launch" OR "Rocket Lab" OR ULA OR ' +
      '"crew launch" OR docking OR payload OR "launch window") ' +
      "(rocket OR mission OR orbit OR pad OR booster) " +
      "-is:retweet lang:en -crypto -shareholder -IPO",
  },
  {
    id: "vera_rubin",
    label: "Vera Rubin / LSST",
    queryTerms:
      '("Rubin Observatory" OR LSST OR LSSTCam OR "Legacy Survey of Space and Time" OR ' +
      '"Simonyi Survey" OR "Rubin science" OR "Rubin data" OR DP1 OR DP2 OR ' +
      '"Vera C. Rubin") -NVIDIA -GPU -Hynix -COMPUTEX -Blackwell -crypto -rack ' +
      "-is:retweet lang:en",
  },
  {
    id: "telescopes",
    label: "Telescopes",
    queryTerms:
      '(JWST OR "James Webb" OR Hubble OR "Hubble Space" OR ' +
      '"Roman Space Telescope" OR ALMA OR NOIRLab OR ESO OR ' +
      '"Very Large Telescope" OR "Webb telescope" OR Chandra OR ' +
      '"Event Horizon Telescope") (NASA OR ESA OR astronom OR galaxy OR nebula OR ' +
      'exoplanet OR "space telescope") -concert -ticket -WTS -Samsung -iPhone ' +
      "-is:retweet lang:en -crypto",
  },
  {
    id: "astronomy",
    label: "Astronomy Buzz",
    queryTerms:
      '(astronomy OR astrophotography OR supernova OR quasar OR nebula OR ' +
      'exoplanet OR "black hole" OR aurora OR "meteor shower" OR comet OR NEO) ' +
      '(NASA OR ESA OR telescope OR "night sky" OR observatory OR astronom) ' +
      "-Samsung -Galaxy -iPhone -WTS -ticket -EXO -crypto -is:retweet lang:en",
  },
  {
    id: "watchlist",
    label: "Watchlist Accounts",
    // vera-home data/social/x_watchlist.json (usernames only).
    queryTerms:
      "Recent posts from these watched accounts: @AstronomyVibes, @doktornihil, " +
      "@WorldAndScience, @universetoday, @NASA, @ESO, @NOIRLabAstro, @halocme",
    handles: [
      "AstronomyVibes",
      "doktornihil",
      "WorldAndScience",
      "universetoday",
      "NASA",
      "ESO",
      "NOIRLabAstro",
      "halocme",
    ],
  },
];
