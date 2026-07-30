/* B-NAN local storage layer — plain IndexedDB, no dependencies.
   Everything lives on-device: ROM blobs, save states, settings, and
   (once fetched) box art. Nothing here ever talks to a network except
   the one-time box art lookup in artwork.js, which is opt-in per game. */

const RBDB = (() => {
  const DB_NAME = "bnan";
  const LEGACY_DB_NAME = "retrobanana"; // pre-rename name -- migrated once, see migrateLegacy()
  // v2: split romBlob/artBlob out of "games" into their own object stores
  // (romBlobs/artBlobs, keyed by the same game id). Real bug this fixes,
  // found by hand: every play session touched updateGame() at least
  // twice (lastPlayedAt/playCount on launch, playtimeSeconds on exit),
  // and v1's schema had romBlob sitting INLINE in the same record --
  // updateGame's own get-modify-put read the ENTIRE record (multi-GB ROM
  // included) off disk and wrote the whole thing back, just to change a
  // number. For a several-GB 3DS dump, that's the actual reason both
  // "loading a game" and "returning to the library" were slow -- nothing
  // to do with network or the emulator core itself. Same reasoning hit
  // getAllGames() (rendering the library grid never needed romBlob at
  // all, but read every single one into memory regardless).
  const DB_VERSION = 2;
  let dbPromise = null;

  function openNamed(name, version, onUpgrade) {
    return new Promise((resolve, reject) => {
      const req = version ? indexedDB.open(name, version) : indexedDB.open(name);
      if (onUpgrade) {
        req.onupgradeneeded = (e) => onUpgrade(req.result, req.transaction, e.oldVersion);
      }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function createSchema(db, upgradeTx, oldVersion) {
    if (!db.objectStoreNames.contains("games")) {
      const games = db.createObjectStore("games", { keyPath: "id" });
      games.createIndex("systemId", "systemId");
      games.createIndex("favorite", "favorite");
      games.createIndex("lastPlayedAt", "lastPlayedAt");
    }
    if (!db.objectStoreNames.contains("states")) {
      const states = db.createObjectStore("states", { keyPath: "key" });
      states.createIndex("gameId", "gameId");
    }
    if (!db.objectStoreNames.contains("settings")) {
      db.createObjectStore("settings", { keyPath: "key" });
    }
    if (!db.objectStoreNames.contains("romBlobs")) {
      db.createObjectStore("romBlobs", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("artBlobs")) {
      db.createObjectStore("artBlobs", { keyPath: "id" });
    }
    // Only real upgrades (an existing v1 database) have inline blobs to
    // pull back out -- a brand-new install has nothing to migrate here
    // (oldVersion is 0), and migrateLegacy()'s own v1-shaped rows go
    // through the same split separately, see below.
    if (oldVersion > 0 && oldVersion < 2) {
      const gameStore = upgradeTx.objectStore("games");
      const romStore = upgradeTx.objectStore("romBlobs");
      const artStore = upgradeTx.objectStore("artBlobs");
      gameStore.openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        const g = cursor.value;
        if (g.romBlob !== undefined) romStore.put({ id: g.id, blob: g.romBlob });
        if (g.artBlob !== undefined && g.artBlob !== null) artStore.put({ id: g.id, blob: g.artBlob });
        delete g.romBlob;
        delete g.artBlob;
        cursor.update(g);
        cursor.continue();
      };
    }
  }

  function getAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function putAll(db, storeName, rows) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, "readwrite");
      const store = t.objectStore(storeName);
      rows.forEach((r) => store.put(r));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  // One-time copy of everything from the pre-rename "retrobanana" database
  // into the new "bnan" one, so renaming the app doesn't quietly orphan
  // anyone's existing library. Runs once; the legacy database is left in
  // place afterward (harmless, a few MB at most) rather than deleted, in
  // case anything went wrong and a human needs to look at it.
  async function migrateLegacy() {
    if (!("databases" in indexedDB)) return; // older engines: skip, can't detect the legacy DB safely
    let existing;
    try {
      existing = await indexedDB.databases();
    } catch (e) {
      return;
    }
    const hasLegacy = existing.some((d) => d.name === LEGACY_DB_NAME);
    const hasNew = existing.some((d) => d.name === DB_NAME);
    if (!hasLegacy || hasNew) return;

    const legacyDb = await openNamed(LEGACY_DB_NAME);
    if (!legacyDb.objectStoreNames.contains("games")) {
      legacyDb.close();
      return;
    }
    const [legacyGames, states, settings] = await Promise.all([
      getAll(legacyDb, "games"),
      legacyDb.objectStoreNames.contains("states") ? getAll(legacyDb, "states") : [],
      legacyDb.objectStoreNames.contains("settings") ? getAll(legacyDb, "settings") : [],
    ]);
    legacyDb.close();
    if (legacyGames.length === 0 && states.length === 0 && settings.length === 0) return;

    // "retrobanana" only ever had the old inline-blob shape (it predates
    // the v2 split entirely) -- split it the same way the v1->v2 upgrade
    // in createSchema does, so this path can't reintroduce inline blobs
    // into the new split schema.
    const games = [], romBlobs = [], artBlobs = [];
    legacyGames.forEach((g) => {
      const { romBlob, artBlob, ...meta } = g;
      games.push(meta);
      if (romBlob !== undefined) romBlobs.push({ id: g.id, blob: romBlob });
      if (artBlob !== undefined && artBlob !== null) artBlobs.push({ id: g.id, blob: artBlob });
    });

    const newDb = await openNamed(DB_NAME, DB_VERSION, createSchema);
    await Promise.all([
      putAll(newDb, "games", games),
      putAll(newDb, "states", states),
      putAll(newDb, "settings", settings),
      putAll(newDb, "romBlobs", romBlobs),
      putAll(newDb, "artBlobs", artBlobs),
    ]);
    newDb.close();
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = migrateLegacy()
      .catch(() => {})
      .then(() => openNamed(DB_NAME, DB_VERSION, createSchema));
    return dbPromise;
  }

  // Shared transaction-wrapping helper -- every write method below used to
  // hand-roll its own "new Promise((res, rej) => { t.oncomplete = ...;
  // t.onerror = ... })" (7 near-identical copies, found in a codebase
  // audit). `fn` receives the raw transaction so multi-store operations
  // (deleteGame touches both "games" and "states") work the same way as
  // single-store ones -- callers just call t.objectStore(...) themselves.
  // `fn` can be sync or async; either way the OUTER promise only resolves
  // on the transaction's real `oncomplete`, not just `fn` finishing, so a
  // caller never sees a "success" before IndexedDB itself agrees it's
  // durable.
  function tx(storeNames, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeNames, mode);
          let result;
          Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
          t.oncomplete = () => resolve(result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function uid() {
    return "g_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  return {
    uid,

    async addGame(game) {
      const { romBlob, artBlob, ...meta } = game;
      return tx(["games", "romBlobs", "artBlobs"], "readwrite", (t) => {
        t.objectStore("games").put(meta);
        if (romBlob !== undefined) t.objectStore("romBlobs").put({ id: game.id, blob: romBlob });
        if (artBlob !== undefined && artBlob !== null) t.objectStore("artBlobs").put({ id: game.id, blob: artBlob });
        return game;
      });
    },

    // Metadata-only by design -- title/favorite/lastPlayedAt/playCount/
    // playtimeSeconds updates (every one of them except artwork changes)
    // never touch romBlobs/artBlobs at all, so this stays fast regardless
    // of how big the ROM is. artBlob is the one field that DOES belong to
    // a blob store (see gameMenu.js/artwork.js's own artwork-change
    // calls) -- routed there explicitly, not folded into the games get/put.
    async updateGame(id, patch) {
      const { romBlob, artBlob, ...metaPatch } = patch;
      const stores = ["games"];
      if (artBlob !== undefined) stores.push("artBlobs");
      if (romBlob !== undefined) stores.push("romBlobs"); // never actually happens today, handled for correctness anyway
      return tx(stores, "readwrite", async (t) => {
        const gameStore = t.objectStore("games");
        const existing = await reqToPromise(gameStore.get(id));
        if (!existing) return null;
        const updated = Object.assign(existing, metaPatch);
        gameStore.put(updated);
        if (artBlob !== undefined) t.objectStore("artBlobs").put({ id, blob: artBlob });
        if (romBlob !== undefined) t.objectStore("romBlobs").put({ id, blob: romBlob });
        return updated;
      });
    },

    async deleteGame(id) {
      return tx(["games", "states", "romBlobs", "artBlobs"], "readwrite", (t) => {
        t.objectStore("games").delete(id);
        t.objectStore("romBlobs").delete(id);
        t.objectStore("artBlobs").delete(id);
        const stateIdx = t.objectStore("states").index("gameId");
        const cursorReq = stateIdx.openCursor(IDBKeyRange.only(id));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        return true;
      });
    },

    // Bulk delete for multi-select -- one transaction for every game +
    // their save states, instead of N separate round trips.
    async deleteGames(ids) {
      if (!ids.length) return 0;
      return tx(["games", "states", "romBlobs", "artBlobs"], "readwrite", (t) => {
        const gameStore = t.objectStore("games");
        const romStore = t.objectStore("romBlobs");
        const artStore = t.objectStore("artBlobs");
        const stateIdx = t.objectStore("states").index("gameId");
        ids.forEach((id) => {
          gameStore.delete(id);
          romStore.delete(id);
          artStore.delete(id);
          const cursorReq = stateIdx.openCursor(IDBKeyRange.only(id));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
        });
        return ids.length;
      });
    },

    // Full merge (metadata + romBlob + artBlob) -- for callers that
    // actually need to play or manage the game's files (player.js,
    // gameMenu.js). Use getAllGames() instead for rendering the library
    // grid, which never needs romBlob.
    async getGame(id) {
      const db = await open();
      const t = db.transaction(["games", "romBlobs", "artBlobs"], "readonly");
      const [meta, rom, art] = await Promise.all([
        reqToPromise(t.objectStore("games").get(id)),
        reqToPromise(t.objectStore("romBlobs").get(id)),
        reqToPromise(t.objectStore("artBlobs").get(id)),
      ]);
      if (!meta) return undefined;
      return Object.assign({}, meta, {
        romBlob: rom ? rom.blob : undefined,
        artBlob: art ? art.blob : null,
      });
    },

    // Metadata + artBlob (for grid thumbnails) but deliberately NOT
    // romBlob -- the library grid never plays a game directly, so
    // pulling every single ROM into memory just to render a list of
    // titles was pure waste, worse the bigger your library/ROMs get.
    async getAllGames() {
      const db = await open();
      const t = db.transaction(["games", "artBlobs"], "readonly");
      const [metas, arts] = await Promise.all([
        reqToPromise(t.objectStore("games").getAll()),
        reqToPromise(t.objectStore("artBlobs").getAll()),
      ]);
      const artById = new Map(arts.map((a) => [a.id, a.blob]));
      return metas.map((m) => Object.assign({}, m, { artBlob: artById.get(m.id) || null }));
    },

    // Dedicated helper for flushPlaytime (player.js) -- reading the
    // current value via getGame() first (full merge, romBlob included)
    // just to add a few seconds to it would reintroduce the exact
    // multi-GB read this whole split was meant to avoid. Metadata-only,
    // same as updateGame.
    async incrementPlaytime(id, seconds) {
      return tx("games", "readwrite", async (t) => {
        const store = t.objectStore("games");
        const existing = await reqToPromise(store.get(id));
        if (!existing) return null;
        existing.playtimeSeconds = (existing.playtimeSeconds || 0) + seconds;
        store.put(existing);
        return existing;
      });
    },

    async saveState(entry) {
      // entry: { gameId, slot, data (Blob), thumbnail (dataURL string|null), createdAt }
      const key = `${entry.gameId}::${entry.slot}`;
      return tx("states", "readwrite", (t) => {
        t.objectStore("states").put(Object.assign({ key }, entry));
        return true;
      });
    },

    async getState(gameId, slot) {
      const db = await open();
      return reqToPromise(
        db.transaction("states", "readonly").objectStore("states").get(`${gameId}::${slot}`)
      );
    },

    async getStatesForGame(gameId) {
      const db = await open();
      const idx = db.transaction("states", "readonly").objectStore("states").index("gameId");
      return reqToPromise(idx.getAll(IDBKeyRange.only(gameId)));
    },

    async deleteState(gameId, slot) {
      return tx("states", "readwrite", (t) => {
        t.objectStore("states").delete(`${gameId}::${slot}`);
        return true;
      });
    },

    async getSetting(key, fallback) {
      const db = await open();
      const row = await reqToPromise(
        db.transaction("settings", "readonly").objectStore("settings").get(key)
      );
      return row ? row.value : fallback;
    },

    async setSetting(key, value) {
      return tx("settings", "readwrite", (t) => {
        t.objectStore("settings").put({ key, value });
        return value;
      });
    },
  };
})();
