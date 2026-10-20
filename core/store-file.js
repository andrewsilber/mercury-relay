// JSON-file store with batched, atomic writes (temp file + rename).
// Interface (shared by future SQLite/Postgres stores): load() -> data, save() (batched), saveNow(), flush().
const fs = require('fs');
module.exports = function createFileStore({ file, saveMs = 200 } = {}) {
  let data = null, timer = null, dirty = false;
  const store = {
    backend: 'json-file', file,
    async init() { return store; },
    drain() { return Promise.resolve(); },
    async close() { store.flush(); },
    async info() { let bytes = 0; try { bytes = fs.statSync(file).size; } catch {} return { backend: 'json-file', file, bytes }; },
    load() {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
      return data;
    },
    saveNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      dirty = false;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    },
    save() { dirty = true; if (!timer) timer = setTimeout(store.saveNow, saveMs); },
    pending() { return dirty || !!timer; },
    flush() { if (store.pending()) store.saveNow(); },
  };
  return store;
};
