// `anymcp` command. With no arguments it runs the MCP server on stdio (what AI apps launch).

import fs from "node:fs";
import { validateProfile } from "@anymcp/shared";
import { setSiteApproval } from "./approvals.js";
import { Catalog } from "./catalog.js";
import { getPaths, loadSettings, loadState } from "./config.js";
import { isPaceSetting, Pacer, resumeSite, setPace } from "./pacing.js";
import { log, serve } from "./server.js";
import { SERVER_HELP, serverCommand } from "./servers-cli.js";
import { getStats, resetStats, statsSummary } from "./stats.js";
import { VERSION } from "./version.js";

const HELP = `AnyMCP ${VERSION}: one MCP server for every website.

Usage:
  anymcp                     Run the MCP server (add this command to your AI app)
  anymcp token               Print the pairing token for the browser extension
  anymcp list                List site profiles and whether you've allowed them
  anymcp allow <profile-id>  Allow a site's tools without being asked
  anymcp revoke <profile-id> Remove that approval
  anymcp install <file.json> Add a profile file as one of your own profiles
  anymcp remove <profile-id> Delete one of your own profiles
  anymcp validate <file>     Check a profile file
  anymcp stats [reset]       How many tokens AnyMCP has saved
  anymcp pace                Show how AnyMCP paces each site, and any paused sites
  anymcp pace <site> <pace>  Set a site's pace: strict, normal, relaxed, off or auto
  anymcp resume <site>       End a pause early, once you've cleared the site's check
${SERVER_HELP}
  anymcp --version

Add to Claude Code:  claude mcp add anymcp -- npx -y anymcp-gateway
Files live in ~/.anymcp (set ANYMCP_HOME to change).`;

function readProfileFile(file: string | undefined): unknown {
  if (!file) {
    console.error("Pass a profile file.");
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Could not read ${file}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function catalog(): Catalog {
  const c = new Catalog(getPaths(), (m) => console.error(m));
  c.reload();
  return c;
}

async function main(): Promise<void> {
  const [cmd, arg, arg2] = process.argv.slice(2);
  const paths = getPaths();

  switch (cmd) {
    case undefined:
    case "serve":
      await serve();
      return;

    case "token":
      console.log(loadSettings(paths).token);
      return;

    case "list": {
      const state = loadState(paths);
      const entries = catalog().all();
      if (!entries.length) console.log("No profiles.");
      for (const e of entries) {
        const allowed = state.approvals[e.profile.id]?.site ? "allowed" : "not allowed yet";
        console.log(`${e.profile.id.padEnd(30)} ${e.source.padEnd(9)} ${String(e.profile.tools.length).padStart(3)} tools  ${allowed}`);
      }
      return;
    }

    case "allow":
    case "revoke": {
      if (!arg) {
        console.error(`Usage: anymcp ${cmd} <profile-id>`);
        process.exit(1);
      }
      if (cmd === "allow" && !catalog().get(arg)) {
        console.error(`No profile "${arg}". Run \`anymcp list\` to see them.`);
        process.exit(1);
      }
      setSiteApproval(paths, arg, cmd === "allow");
      console.log(cmd === "allow" ? `Allowed ${arg}.` : `Removed approval for ${arg}.`);
      return;
    }

    case "install": {
      const data = readProfileFile(arg);
      try {
        const p = catalog().saveLocal(data);
        console.log(`Installed ${p.id} (${p.tools.length} tools).`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      return;
    }

    case "remove":
      if (!arg || !catalog().deleteLocal(arg)) {
        console.error(`No local profile "${arg ?? ""}".`);
        process.exit(1);
      }
      console.log(`Removed ${arg}.`);
      return;

    case "validate": {
      const r = validateProfile(readProfileFile(arg));
      if (r.ok) console.log(`OK: ${r.profile.id}, ${r.profile.tools.length} tools.`);
      else {
        console.error(r.errors.join("\n"));
        process.exit(1);
      }
      return;
    }

    case "stats":
      if (arg === "reset") {
        resetStats(paths);
        console.log("Stats reset.");
      } else console.log(statsSummary(getStats(paths, catalog())));
      return;

    case "pace": {
      if (arg && arg2) {
        if (!isPaceSetting(arg2)) {
          console.error("The pace is one of: strict, normal, relaxed, off, auto.");
          process.exit(1);
        }
        const site = setPace(paths, arg, arg2);
        console.log(arg2 === "auto" ? `${site} is back to AnyMCP's pace.` : `${site}: ${arg2} pace.`);
        if (arg2 === "off" || arg2 === "relaxed") {
          console.log("Going faster raises the chance the site limits or blocks your account.");
        }
        return;
      }
      if (arg) {
        console.error("Usage: anymcp pace <site> <strict|normal|relaxed|off|auto>");
        process.exit(1);
      }
      const rows = new Pacer({ paths }).status();
      if (!rows.length) console.log("AnyMCP hasn't called any sites yet.");
      for (const r of rows) {
        const paused = r.pausedUntil ? `  PAUSED until ${new Date(r.pausedUntil).toLocaleString()} (${r.pauseReason})` : "";
        const pace = `${r.pace}${r.chosenByUser ? " (yours)" : ""}`;
        console.log(
          `${r.site.padEnd(26)} ${pace.padEnd(16)} ${String(r.callsLastHour).padStart(4)} calls/hour ${String(r.callsToday).padStart(5)} today ` +
            `${String(r.actionsToday).padStart(4)} actions today${paused}`,
        );
      }
      console.log("\nPaces: strict (social networks), normal (signed-in sites), relaxed (public APIs).");
      return;
    }

    case "resume": {
      if (!arg) {
        console.error("Usage: anymcp resume <site>");
        process.exit(1);
      }
      const r = resumeSite(paths, arg);
      console.log(r.wasPaused ? `Resumed ${r.site}.` : `${r.site} wasn't paused.`);
      return;
    }

    case "server":
    case "servers":
      try {
        await serverCommand(process.argv.slice(3));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      // A closed SSE connection can leave a socket open; we're done either way.
      process.exit(0);

    case "--version":
    case "-v":
      console.log(VERSION);
      return;

    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
