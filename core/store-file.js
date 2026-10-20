// JSON-file store with batched, atomic writes (temp file + rename).
// Interface (shared by future SQLite/Postgres stores): load() -> data, save() (batched), saveNow(), flush().
const fs = require('fs');
module.exports = function createFileStore({ file, saveMs = 200 } = {}) {
  let data = null, timer = null, dirty = false;
  const store = {
    file,
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
