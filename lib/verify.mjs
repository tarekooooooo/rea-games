// Runs a port over every recorded case and compares its trace with the original's.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { firstDiff } from "./compare.mjs";

export function loadGame(root, name) {
  const dir = path.join(root, "games", name);
  const gameJson = path.join(dir, "game.json");
  if (!fs.existsSync(gameJson)) throw new Error(`no game "${name}" (games: ${listGames(root).join(", ")}). Create one with: rea-games new ${name}`);
  const meta = JSON.parse(fs.readFileSync(gameJson, "utf8"));
  return { dir, meta };
}

export function listGames(root) {
  return fs.readdirSync(path.join(root, "games")).filter((n) => fs.existsSync(path.join(root, "games", n, "game.json"))).sort();
}

export function loadCases(dir) {
  const cd = path.join(dir, "cases");
  if (!fs.existsSync(cd)) return [];
  // cases are stored as .json, or as .json.gz once packed (`rea-games pack`) to keep the repository small
  return fs.readdirSync(cd).filter((f) => f.endsWith(".json") || f.endsWith(".json.gz")).sort().map((f) => {
    const buf = fs.readFileSync(path.join(cd, f));
    return { file: f.replace(/\.gz$/, ""), raw: (f.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8") };
  });
}

// What went wrong, from a crashed port's stderr. Node ends an uncaught error with its stack, a blank
// line and `Node.js vNN`, so the last lines are never the error. Blank lines and that version line
// are dropped. The reason starts at the last message line (not indented, and not the `}` that closes
// an error's properties). If a stack follows it, the reason is the line where that error begins and
// the stack's first frame (where it was thrown). A message may go on in more lines, indented or not,
// before its stack, so the error's first line (`Error: ...`, `TypeError: ...`, `AssertionError
// [ERR_ASSERTION]: ...`) is looked for going up from the message line, never past an earlier stack;
// without one it is the message line. Otherwise (a Rust panic, text printed after a logged error) it
// is the last two lines, so an error logged earlier never hides the one that ended the port.
export function crashReason(stderr) {
  const lines = (stderr || "").split("\n").filter((l) => l.trim() && !/^Node\.js v\d/.test(l));
  let i = lines.length - 1;
  while (i >= 0 && (/^\s/.test(lines[i]) || lines[i].trim() === "}")) i--;
  const frame = i >= 0 ? lines.slice(i + 1).find((l) => /^\s+at /.test(l)) : undefined;
  return (frame ? [errorLine(lines, i), frame] : lines.slice(-2)).map((l) => l.trim()).join(" | ");
}

function errorLine(lines, i) {
  for (let j = i; j >= 0 && !/^\s+at /.test(lines[j]); j--) if (/^\w*Error( \[\w+\])?:/.test(lines[j])) return lines[j];
  return lines[i];
}

export function verifyPort(root, name, portName, log = console.log) {
  const { dir, meta } = loadGame(root, name);
  const port = meta.ports[portName];
  if (!port) throw new Error(`${name} has no port "${portName}" (has: ${Object.keys(meta.ports).join(", ")})`);
  if (port.build) {
    const b = spawnSync(port.build[0], port.build.slice(1), { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
    if (b.status !== 0) throw new Error(`build of ${name}/${portName} failed`);
  }
  const cases = loadCases(dir);
  if (cases.length === 0) throw new Error(`no recorded cases in games/${name}/cases; run: rea-games record ${name}`);
  let passed = 0, inputs = 0, frames = 0;
  const failures = [];
  for (const { file, raw } of cases) {
    const c = JSON.parse(raw);
    // `godot` means the binary in $REA_GODOT when set, so a download outside PATH works
    const exe = port.cmd[0] === "godot" && process.env.REA_GODOT ? process.env.REA_GODOT : port.cmd[0];
    const r = spawnSync(exe, port.cmd.slice(1), { cwd: dir, input: raw, maxBuffer: 1 << 29, encoding: "utf8", timeout: 120000 }); // a hung port fails the case, not the run
    let problem = null;
    if (r.error?.code === "ENOENT") problem = `${exe} not found${port.cmd[0] === "godot" ? " (install Godot 4.4 or set REA_GODOT to the binary)" : ""}`;
    else if (r.error?.code === "ETIMEDOUT") problem = "port did not finish within 120 s";
    else if (r.status !== 0) problem = r.signal ? `port was killed by ${r.signal}` : `port exited ${r.status}: ${crashReason(r.stderr)}`;
    else {
      let out;
      // engines print a banner before the program's output: the result is the one line that starts with "{"
      const line = r.stdout.split("\n").find((l) => l.startsWith("{")) ?? r.stdout;
      try { out = JSON.parse(line); } catch { problem = "port printed something that is not JSON"; }
      if (!problem) {
        const d = firstDiff(c.trace, out.trace);
        if (d) problem = `trace differs at ${d}`;
        else if (out.tapeUsed !== c.tape.length) problem = `used ${out.tapeUsed} of the ${c.tape.length} recorded random numbers`;
      }
    }
    if (problem) { failures.push({ file, problem }); log(`  FAIL ${file}: ${problem}`); if (r.error?.code === "ENOENT") break; }
    else { passed++; inputs += c.inputs.length; frames += c.trace.length; log(`  ok   ${file}  (${c.inputs.length} inputs)`); }
  }
  return { name, port: portName, cases: cases.length, passed, inputs, frames, failures };
}

// Verifies every port of each game (or only `portName`), one after the other. A port that cannot
// run (its build fails, or the game has no such port) is that port's failure, with the reason in
// `error`; the next port and game still run.
export function verifyGames(root, names, portName, log = console.log) {
  const results = [];
  for (const g of names) {
    const { meta } = loadGame(root, g);
    for (const p of portName ? [portName] : Object.keys(meta.ports)) {
      log(`${g} / ${p}`);
      let r;
      try {
        r = verifyPort(root, g, p, log);
        log(`  => ${r.passed}/${r.cases} cases identical, ${r.inputs} inputs, ${r.frames} recorded states`);
      } catch (e) {
        r = { name: g, port: p, cases: 0, passed: 0, inputs: 0, frames: 0, failures: [], error: e.message };
        log(`  FAIL ${e.message}`);
      }
      results.push(r);
    }
  }
  return results;
}

// One line per game and port, for the end of a run; a port that failed starts with FAIL.
export function summaryLines(results) {
  const labels = results.map((r) => `${r.name} / ${r.port}`);
  const width = Math.max(0, ...labels.map((l) => l.length)) + 2;
  return results.map((r, i) => {
    const counts = `${r.passed}/${r.cases} cases identical, ${r.inputs} inputs, ${r.frames} recorded states`;
    return `${labels[i].padEnd(width)}=> ${r.error ? `FAIL ${r.error}` : r.failures.length ? `FAIL ${counts}` : counts}`;
  });
}

// Gzips every plain .json case; packed counts the files gzipped now, alreadyPacked the .json.gz ones found as they were.
export function packCases(root, name) {
  const { dir } = loadGame(root, name);
  const cd = path.join(dir, "cases");
  if (!fs.existsSync(cd)) throw new Error(`${name} has no cases yet; run: rea-games record ${name}`);
  const files = fs.readdirSync(cd);
  let before = 0, after = 0, packed = 0;
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const buf = fs.readFileSync(path.join(cd, f));
    const gz = zlib.gzipSync(buf, { level: 9 });
    fs.writeFileSync(path.join(cd, f + ".gz"), gz);
    fs.unlinkSync(path.join(cd, f));
    before += buf.length; after += gz.length; packed++;
  }
  return { packed, alreadyPacked: files.filter((x) => x.endsWith(".json.gz")).length, before, after };
}

// Bytes as MB, or as KB below 0.1 MB so small games do not all read "0.0 MB".
export function formatSize(bytes) {
  return bytes < 1e5 ? `${(bytes / 1e3).toFixed(1)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

// One line of `rea-games pack` output for a packCases result.
export function packLine(name, r) {
  const cases = (n) => `${n} case${n === 1 ? "" : "s"}`;
  if (!r.packed) return `${name}: ${r.alreadyPacked ? `already packed (${cases(r.alreadyPacked)})` : "no cases to pack"}`;
  const also = r.alreadyPacked ? `, ${r.alreadyPacked} already packed` : "";
  return `${name}: ${formatSize(r.before)} -> ${formatSize(r.after)} (${cases(r.packed)} packed${also})`;
}
