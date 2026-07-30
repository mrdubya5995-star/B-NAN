/* B-NAN box art — matches a game's title against libretro-thumbnails,
   the same public dataset RetroArch itself uses for box art (organized
   by system, one PNG per game, named after the game).

   This is the ONE place B-NAN talks to the network unprompted (once per
   newly-added game, to fetch a picture — never ROMs, never anything you
   didn't ask for). The image is downloaded once and stored as a Blob in
   IndexedDB, same as everything else, so the library still works offline
   after that. A lookup miss just leaves the placeholder tile; it never
   blocks adding the game.

   How this actually works (verified by hand against the live service,
   not assumed): thumbnails.libretro.com itself sends no CORS headers,
   so a browser can't fetch from it directly -- every request gets
   blocked before this code ever sees a response. Its real filenames
   also keep the release/region tag ("Sonic 3 (Europe).png",
   "Streets of Rage 2 (USA).png") rather than a bare title, so even a
   CORS-free guess at "Sonic 3.png" would still 404 -- there is no
   universal tag to strip down to that matches every game.

   What DOES work: GitHub's own API (api.github.com and
   raw.githubusercontent.com) sends `Access-Control-Allow-Origin: *` on
   every request, and libretro-thumbnails is literally hosted as one
   GitHub repo per system. So this fetches that system's real file
   listing once (cached, see fetchIndex), matches the tag-stripped game
   title against the tag-stripped version of every real filename, and
   only then downloads the exact file that actually exists. This is
   also where "New Super Mario Bros (US)(ENG)" finding art filed under
   "New Super Mario Bros (USA).png" actually comes from: both sides get
   their release tags stripped before comparing, but the real tagged
   filename is what's downloaded.

   Two more things found by hand, not assumed, after the first version
   of this file still missed real games:

   1. An exact string match after stripping tags is still too strict.
   The real dataset uses the game's official title, which doesn't
   always match how people naturally type it -- e.g. the actual file is
   "Pokemon - LeafGreen Version (USA, Europe).png" (no space in
   "LeafGreen"), so someone typing "Pokemon Leaf Green" would never hit
   it on exact match. So the comparison strips ALL whitespace/
   punctuation too (not just tags), down to a plain lowercase a-z0-9
   string, and matches when one side is a prefix of the other -- covers
   the dataset having extra trailing words ("...Version") or the typed
   title having them.

   2. That prefix rule alone is dangerous for short/generic titles: a
   bare "Mario" or "Zelda" query is a *prefix* of dozens of unrelated
   games ("Mario Pinball Land", a random Japan-only Zelda tie-in) and
   would confidently attach the wrong art. Verified this by hand against
   real data before, not after, shipping it. So: titles under 8
   characters after stripping only ever match exactly, never by prefix
   -- short titles either hit dead-on or get no art, never a guess.

   Also handled: No-Intro's own sorting convention moves a leading
   article to the end ("The Legend of Zelda" is filed as "Legend of
   Zelda, The") -- both word orders are tried. */

const RBArtwork = (() => {
  const API = "https://api.github.com/repos/libretro-thumbnails";
  const RAW = "https://raw.githubusercontent.com/libretro-thumbnails";
  const INDEX_CACHE_DAYS = 14;
  const REGION_PRIORITY = ["World", "USA", "Europe", "USA, Europe", "Japan"];

  // Strips ANY (...)／[...]／{...} group -- release tags like (USA), [!],
  // (En,Fr,De), {Rev 1} -- and collapses the whitespace left behind, so
  // "New Super Mario Bros (US)(EN)" becomes "New Super Mario Bros".
  function normalizeTitle(title) {
    return String(title || "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // "Sega - Mega Drive - Genesis" -> "Sega_-_Mega_Drive_-_Genesis", matching
  // libretro-thumbnails' actual GitHub repo slugs (verified against the org's
  // repo list).
  function repoSlug(thumbRepo) {
    return String(thumbRepo || "").replace(/ - /g, "_-_").replace(/ /g, "_");
  }

  function slugify(title) {
    return normalizeTitle(title).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  const MIN_FUZZY_LEN = 8; // shorter than this: exact-match only, never prefix-guessed

  // "The Legend of Zelda - The Minish Cap" -> "Legend of Zelda, The - The
  // Minish Cap", matching No-Intro's own article-at-the-end convention.
  // Returns null if the title doesn't start with an article.
  function articleMoved(title) {
    const m = /^(the|a|an)\s+(.+)$/i.exec(normalizeTitle(title));
    if (!m) return null;
    const rest = m[2];
    const sep = rest.indexOf(" - ");
    return sep === -1 ? `${rest}, ${m[1]}` : `${rest.slice(0, sep)}, ${m[1]}${rest.slice(sep)}`;
  }

  const memoryIndex = new Map(); // repoSlug -> string[] filenames, or null (confirmed miss for this session)

  async function fetchIndex(slug) {
    if (memoryIndex.has(slug)) return memoryIndex.get(slug);

    const cacheKey = `artIndex:${slug}`;
    const cached = await RBDB.getSetting(cacheKey, null);
    if (cached && Array.isArray(cached.files) && Date.now() - cached.fetchedAt < INDEX_CACHE_DAYS * 86400000) {
      memoryIndex.set(slug, cached.files);
      return cached.files;
    }

    let files = null;
    try {
      const res = await fetch(`${API}/${encodeURIComponent(slug)}/git/trees/master?recursive=1`);
      if (res.ok) {
        const data = await res.json();
        files = (data.tree || [])
          .filter((t) => t.path.startsWith("Named_Boxarts/") && /\.png$/i.test(t.path))
          .map((t) => t.path.slice("Named_Boxarts/".length));
      }
    } catch (e) {
      files = null; // offline, network error, or the repo doesn't exist -- same outcome: no index this time
    }

    if (files) await RBDB.setSetting(cacheKey, { fetchedAt: Date.now(), files });
    memoryIndex.set(slug, files);
    return files;
  }

  function pickBest(matches, querySlug) {
    // Prefer the most "standard" region release -- and within that
    // region, the shortest filename (fewest extra (Demo)/(Beta)/(Rev 1)
    // qualifiers, since those are also stripped by normalizeTitle and so
    // all tie on slug length otherwise).
    for (const region of REGION_PRIORITY) {
      const hits = matches.filter((f) => f.includes(`(${region})`));
      if (hits.length) return hits.slice().sort((a, b) => a.length - b.length)[0];
    }
    // No region-tagged hit at all -- fall back to closest length match.
    return matches
      .slice()
      .sort((a, b) => Math.abs(slugify(a).length - querySlug.length) - Math.abs(slugify(b).length - querySlug.length))[0];
  }

  // Matches one already-slugified query against one system's file index.
  function matchAgainst(files, querySlug) {
    if (querySlug.length < 3) return null;

    const exact = files.filter((f) => slugify(f.replace(/\.png$/i, "")) === querySlug);
    if (exact.length) return pickBest(exact, querySlug);
    if (querySlug.length < MIN_FUZZY_LEN) return null;

    // Safe direction: the real filename has extra trailing words we don't
    // (e.g. "...Version") -- we're not throwing away anything the player typed.
    const withExtra = files.filter((f) => {
      const c = slugify(f.replace(/\.png$/i, ""));
      return c.length >= querySlug.length && c.startsWith(querySlug);
    });
    if (withExtra.length) return pickBest(withExtra, querySlug);

    // Riskier direction: what was typed has extra words the dataset
    // doesn't. Still gated by MIN_FUZZY_LEN on the candidate too, so a
    // long typed title can't collapse onto a short generic entry.
    const queryHasExtra = files.filter((f) => {
      const c = slugify(f.replace(/\.png$/i, ""));
      return c.length >= MIN_FUZZY_LEN && querySlug.startsWith(c);
    });
    if (queryHasExtra.length) return pickBest(queryHasExtra, querySlug);

    return null;
  }

  async function fetchBlob(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      return blob && blob.size ? blob : null;
    } catch (e) {
      return null;
    }
  }

  // Looks a game up and returns { blob, matchedTitle, url } or null.
  async function lookup(system, title) {
    if (!system || !system.thumbRepo) return null;

    const slug = repoSlug(system.thumbRepo);
    const files = await fetchIndex(slug);
    if (!files || files.length === 0) return null;

    const titleVariants = [title, articleMoved(title)].filter(Boolean);
    let chosen = null;
    for (const variant of titleVariants) {
      chosen = matchAgainst(files, slugify(variant));
      if (chosen) break;
    }
    if (!chosen) return null;

    const url = `${RAW}/${encodeURIComponent(slug)}/master/Named_Boxarts/${encodeURIComponent(chosen)}`;
    const blob = await fetchBlob(url);
    if (!blob) return null;
    return { blob, matchedTitle: chosen.replace(/\.png$/i, ""), url };
  }

  // Fire-and-forget hook for freshly-imported games: never throws, never
  // blocks the caller -- "added to library" must feel instant regardless
  // of network conditions.
  async function autoFetch(game, system) {
    try {
      const found = await lookup(system, game.title);
      if (!found) return false;
      await RBDB.updateGame(game.id, { artBlob: found.blob, artSource: "auto", artMatchedTitle: found.matchedTitle });
      return true;
    } catch (e) {
      return false;
    }
  }

  return { normalizeTitle, lookup, autoFetch };
})();
