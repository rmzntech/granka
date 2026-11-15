// Atomic file writes: write to a temp file in the same directory, then rename.
// A crash or kill mid-write no longer leaves a truncated config/map/prompt.
import fs from "node:fs";
import path from "node:path";

export function writeFileAtomic(file, data, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, data, { mode: options.mode ?? 0o644 });
    if (options.mode) {
      try { fs.chmodSync(tmp, options.mode); } catch {}
    }
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}
