/* B-NAN local storage layer — plain IndexedDB, no dependencies.
   Everything lives on-device: ROM blobs, save states, settings, and
   (once fetched) box art. Nothing here ever talks to a network except
   the one-time box art lookup in artwork.js, which is opt-in per game. */

const RBDB = (() => {
  const DB_NAME = "bnan";
  const LEGACY_DB_NAME = "retrobanana"; // pre-rename name -- migrated once, see migrateLegacy()
  const DB_VERSION = 1;
  let dbPromise = null;

  function openNamed(name, version, onUpgrade) {
    return new Promise((resolve, reject) => {
      const req = version ? indexedDB.open(name, version) : indexedDB.open(name);
      if (onUpgrade) req.onupgradeneeded = () => onUpgrade(req.result);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function createSchema(db) {
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
    const [games, states, settings] = await Promise.all([
      getAll(legacyDb, "games"),
      legacyDb.objectStoreNames.contains("states") ? getAll(legacyDb, "states") : [],
      legacyDb.objectStoreNames.contains("settings") ? getAll(legacyDb, "settings") : [],
    ]);
    legacyDb.close();
    if (games.length === 0 && states.length === 0 && settings.length === 0) return;

    const newDb = await openNamed(DB_NAME, DB_VERSION, createSchema);
    await Promise.all([
      putAll(newDb, "games", games),
      putAll(newDb, "states", states),
      putAll(newDb, "settings", settings),
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
      return tx("games", "readwrite", (t) => {
        t.objectStore("games").put(game);
        return game;
      });
    },

    async updateGame(id, patch) {
      return tx("games", "readwrite", async (t) => {
        const store = t.objectStore("games");
        const existing = await reqToPromise(store.get(id));
        if (!existing) return null;
        const updated = Object.assign(existing, patch);
        store.put(updated);
        return updated;
      });
    },

    async deleteGame(id) {
      return tx(["games", "states"], "readwrite", (t) => {
        t.objectStore("games").delete(id);
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
      return tx(["games", "states"], "readwrite", (t) => {
        const gameStore = t.objectStore("games");
        const stateIdx = t.objectStore("states").index("gameId");
        ids.forEach((id) => {
          gameStore.delete(id);
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

    async getGame(id) {
      const db = await open();
      return reqToPromise(db.transaction("games", "readonly").objectStore("games").get(id));
    },

    async getAllGames() {
      const db = await open();
      return reqToPromise(db.transaction("games", "readonly").objectStore("games").getAll());
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
