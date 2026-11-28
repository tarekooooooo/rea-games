#!/usr/bin/env node
// rea-games: record a game's original, check a port against the recording.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listGames, loadGame, verifyGames, summaryLines, packCases, packLine } from "../lib/verify.mjs";
import { scaffold } from "../lib/scaffold.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);

const help = `rea-games: reverse-engineer a game's behavior, then check a rebuild against it

  rea-games list                        games, their ports and recorded cases
  rea-games new <game>                  scaffold games/<game> (game.json, record.mjs, GAME.md, port stub)
  rea-games record <game>               run the original and write cases/*.json
  rea-games pack <game|all>             gzip the cases (the repository keeps them packed)
  rea-games verify <game|all> [--port web|godot|bevy]   replay every case through a port
  rea-games --version, -v               print the version from package.json
  rea-games --help, -h                  show this help, on its own or after any command
`;

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(help);
  if (cmd === "--version" || cmd === "-v") {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return console.log(version);
  }
  if (["list", "new", "record", "pack", "verify"].includes(cmd)) {
    if (rest.includes("--help") || rest.includes("-h")) return console.log(help);
    if (rest.includes("--version") || rest.includes("-v")) {
      const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      return console.log(version);
    }
    for (let i = 0; i < rest.length; i++) {
      if (cmd === "verify" && (rest[i] === "--port" || rest[i].startsWith("--port="))) {
        if (rest[i] === "--port") i++;
        continue;
      }
      if (rest[i].startsWith("-")) {
        console.error(`rea-games: unknown option "${rest[i]}"`);
        process.exit(2);
      }
    }
  }
  if (cmd === "list") {
    for (const g of listGames(root)) {
      const { dir, meta } = loadGame(root, g);
      const cd = path.join(dir, "cases");
      const cases = fs.existsSync(cd)
        ? fs.readdirSync(cd).filter((f) => f.endsWith(".json") || f.endsWith(".json.gz")).length
        : 0;
      console.log(`${g.padEnd(12)} original: ${meta.original.repo} (${meta.original.license})  ports: ${Object.keys(meta.ports).join(", ")}  cases: ${cases}`);
    }
    return;
  }
  if (cmd === "new") {
    if (!rest[0]) {
      console.error("usage: rea-games new <game>   (lowercase letters, digits and dashes)");
      process.exit(2);
    }
    console.log("created", scaffold(root, rest[0]));
    return;
  }
  if (cmd === "record") {
    if (!rest[0] || rest[0] === "all") {
      console.error(`usage: rea-games record <game>   (games: ${listGames(root).join(", ")})`);
      process.exit(2);
    }
    if (rest.length > 1) {
      console.error(`rea-games: record takes one game, got: ${rest.join(" ")}`);
      process.exit(2);
    }
    const g = rest[0];
    const { dir, meta } = loadGame(root, g);
    const mod = await import(pathToFileURL(path.join(dir, meta.record)).href);
    const result = await mod.record();
    const cd = path.join(dir, "cases");
    if (fs.existsSync(cd)) for (const f of fs.readdirSync(cd)) if (f.endsWith(".json.gz")) fs.rmSync(path.join(cd, f)); // packed copies would go stale
    console.log(`recorded ${g}:`, result);
    return;
  }
  if (cmd === "pack") {
    if (rest.length > 1) {
      console.error(`rea-games: pack takes one game (or all), got: ${rest.join(" ")}`);
      process.exit(2);
    }
    let hadError = false;
    for (const g of rest[0] === "all" || !rest[0] ? listGames(root) : [rest[0]]) {
      try {
        console.log(packLine(g, packCases(root, g)));
      } catch (e) {
        hadError = true;
        console.error(e.message);
      }
    }
    if (hadError) process.exitCode = 1;
    return;
  }
  if (cmd === "verify") {
    const positional = [];
    let portName = null;
    let portMissing = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--port" || a.startsWith("--port=")) {
        const v = a === "--port" ? rest[++i] : a.slice("--port=".length);
        if (v && !v.startsWith("-")) portName = v;
        else portMissing = true;
      } else positional.push(a);
    }
    if (positional.length > 1) {
      console.error(`rea-games: verify takes one game (or all), got: ${positional.join(" ")}`);
      process.exit(2);
    }
    const game = positional[0] || "all";
    if (portMissing) {
      const known = game !== "all" && listGames(root).includes(game) ? loadGame(root, game).meta.ports : null;
      console.error(`--port needs a value${known ? ` (${game} has: ${Object.keys(known).join(", ")})` : ""}`);
      process.exit(2);
    }
    const names = game === "all" ? listGames(root) : [game];
    const results = verifyGames(root, names, portName, console.log, { skipMissing: game === "all" });
    if (results.length > 1) console.log(["", "summary", ...summaryLines(results).map((l) => "  " + l)].join("\n"));
    if (results.length && results.every((r) => r.skipped)) console.error(`no game has a "${portName}" port`);
    process.exit(results.some((r) => r.error || r.failures.length) || results.every((r) => r.skipped) ? 1 : 0);
  }
  console.error(`rea-games: unknown command "${cmd}"\n`);
  console.error(help);
  process.exit(2);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
