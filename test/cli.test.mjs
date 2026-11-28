import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "rea-games.mjs");
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

test("record with no game prints its usage and exits 2", () => {
  const r = run("record");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^usage: rea-games record <game>   \(games: 2048, [^)]+\)$/m);
});

test("an unknown game name gets a readable error, not ENOENT", () => {
  const r = run("verify", "nope");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^no game "nope" \(games: 2048, [^)]+\)\. Create one with: rea-games new nope$/m);
  assert.doesNotMatch(r.stderr, /ENOENT/);
});

test("an unknown command is named on the first line of stderr and exits 2", () => {
  const r = run("frobnicate");
  assert.equal(r.status, 2);
  assert.equal(r.stderr.split("\n")[0], 'rea-games: unknown command "frobnicate"');
  assert.match(r.stderr, /rea-games verify <game\|all>/);
});

test("--version and -v print the version from package.json", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const flag of ["--version", "-v"]) {
    const r = run(flag);
    assert.equal(r.status, 0, flag);
    assert.equal(r.stdout, `${version}\n`, flag);
  }
});

test("--help mentions --version", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  const lines = r.stdout.split("\n");
  const column = (start) => { const l = lines.find((x) => x.startsWith(start)); assert.ok(l, start); return start.length + l.slice(start.length).search(/\S/); };
  const col = column("  rea-games list");
  assert.equal(column("  rea-games --version, -v"), col);
  assert.equal(column("  rea-games --help, -h"), col);
  assert.match(r.stdout, /^  rea-games --version, -v +print the version from package\.json$/m);
  assert.match(r.stdout, /^  rea-games --help, -h +show this help, on its own or after any command$/m);
});

test("--help and -h after a command print the help and exit 0", () => {
  for (const args of [["-h"], ["verify", "--help"], ["verify", "--port", "web", "-h"], ["new", "--help"], ["record", "-h"]]) {
    const r = run(...args);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, /^rea-games: reverse-engineer/, args.join(" "));
  }
});

test("new with no name prints its usage and exits 2", () => {
  const r = run("new");
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "usage: rea-games new <game>   (lowercase letters, digits and dashes)");
});

test("new with an invalid name keeps the name-rule error and exits 1", () => {
  const r = run("new", "Bad_Name");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^game names are lowercase letters, digits and dashes$/m);
});

// bin/ and lib/ in a temporary root with one game whose record.mjs is the given source and whose cases are packed.
function recordRoot(recordSource) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rea-games-record-")));
  for (const p of ["bin", "lib"]) fs.cpSync(path.join(root, p), path.join(dir, p), { recursive: true });
  fs.cpSync(path.join(root, "package.json"), path.join(dir, "package.json"));
  const game = path.join(dir, "games", "demo");
  fs.mkdirSync(path.join(game, "cases"), { recursive: true });
  fs.writeFileSync(path.join(game, "game.json"), JSON.stringify({ name: "demo", original: { repo: "test/test", license: "MIT" }, record: "record.mjs", ports: {} }));
  fs.writeFileSync(path.join(game, "record.mjs"), recordSource);
  for (const f of ["a.json.gz", "b.json.gz"]) fs.writeFileSync(path.join(game, "cases", f), zlib.gzipSync(`{"case":"${f}"}`));
  const record = () => spawnSync(process.execPath, [path.join(dir, "bin", "rea-games.mjs"), "record", "demo"], { encoding: "utf8" });
  return { dir, cases: path.join(game, "cases"), record };
}

test("a record that throws keeps the packed cases", () => {
  const { dir, cases, record } = recordRoot(`export async function record() { throw new Error("recorder broke"); }\n`);
  try {
    const before = fs.readdirSync(cases).sort().map((f) => [f, fs.readFileSync(path.join(cases, f))]);
    const r = record();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /recorder broke/);
    assert.deepEqual(fs.readdirSync(cases).sort().map((f) => [f, fs.readFileSync(path.join(cases, f))]), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a record whose recorder cannot be imported keeps the packed cases", () => {
  const { dir, cases, record } = recordRoot(`import "rea-games-no-such-module";\nexport function record() {}\n`);
  try {
    const r = record();
    assert.equal(r.status, 1);
    assert.deepEqual(fs.readdirSync(cases).sort(), ["a.json.gz", "b.json.gz"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a record that succeeds replaces the packed cases with the new ones", () => {
  const source = `import fs from "node:fs";
export function record() {
  fs.writeFileSync(new URL("./cases/a.json", import.meta.url), "{}");
  return { cases: 1 };
}
`;
  const { dir, cases, record } = recordRoot(source);
  try {
    const r = record();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^recorded demo: \{ cases: 1 \}$/m);
    assert.deepEqual(fs.readdirSync(cases), ["a.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verify --port with no value, or followed by a flag, exits 2 with the game's ports", () => {
  const r = run("verify", "2048", "--port", "--something");
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "--port needs a value (2048 has: web, godot, bevy)");
  const end = run("verify", "2048", "--port");
  assert.equal(end.status, 2);
  assert.equal(end.stderr.trim(), "--port needs a value (2048 has: web, godot, bevy)");
});

test("verify and pack with a second game name exit 2 before anything runs", () => {
  const v = run("verify", "mines", "paddles", "--port", "web");
  assert.equal(v.status, 2);
  assert.equal(v.stderr.trim(), "rea-games: verify takes one game (or all), got: mines paddles");
  assert.equal(v.stdout, "");
  const p = run("pack", "mines", "paddles");
  assert.equal(p.status, 2);
  assert.equal(p.stderr.trim(), "rea-games: pack takes one game (or all), got: mines paddles");
  assert.equal(p.stdout, "");
});

test("verify reads --port=<name> like --port <name>", () => {
  const r = run("verify", "2048", "--port=nope");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^2048 \/ nope$/m);
  assert.match(r.stdout, /FAIL 2048 has no port "nope"/);
});

test("list shows recorded case counts at the end of each line", () => {
  const r = run("list");
  assert.equal(r.status, 0);
  const line = r.stdout.split("\n").find((l) => l.startsWith("2048 "));
  assert.ok(line, r.stdout);
  assert.match(line, /cases: 19$/);
});

test("unknown options after a command exit 2 with an error, and --version/-v print version", () => {
  const r1 = run("verify", "2048", "--prot", "web");
  assert.equal(r1.status, 2);
  assert.equal(r1.stderr.trim(), 'rea-games: unknown option "--prot"');

  const r2 = run("record", "--dry-run");
  assert.equal(r2.status, 2);
  assert.equal(r2.stderr.trim(), 'rea-games: unknown option "--dry-run"');

  const r3 = run("verify", "--prot", "web");
  assert.equal(r3.status, 2);
  assert.equal(r3.stderr.trim(), 'rea-games: unknown option "--prot"');

  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const args of [["list", "--version"], ["verify", "-v"], ["record", "--version"], ["new", "-v"]]) {
    const r = run(...args);
    assert.equal(r.status, 0, args.join(" "));
    assert.equal(r.stdout, `${version}\n`, args.join(" "));
  }
});

test("verify all --port skips games without that port, but fails when no game has it", () => {
  const none = run("verify", "all", "--port", "nope");
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^  2048 \/ nope +=> skipped, no nope port$/m);
  assert.equal(none.stderr.trim(), 'no game has a "nope" port');
  const named = run("verify", "bricks", "--port", "bevy");
  assert.equal(named.status, 1);
  assert.match(named.stdout, /FAIL bricks has no port "bevy" \(has: web\)/);
});

test("record with two game names exits 2 and says it takes one game", () => {
  const r = run("record", "mines", "paddles");
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim(), "rea-games: record takes one game, got: mines paddles");
});

test("record all prints the record usage and exits 2", () => {
  const r = run("record", "all");
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^usage: rea-games record <game>   \(games: 2048, [^)]+\)$/m);
});
