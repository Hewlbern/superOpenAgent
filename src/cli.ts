#!/usr/bin/env node
import { createInterface } from "node:readline";
import { SuperAgent } from "./superagent.js";
import { llmFromEnv } from "./llm.js";
import { LocalEnvironment } from "./environments.js";
import { FileStore } from "./store.js";
import { Watchdog } from "./watchdog.js";

/**
 * Example CLI: a full-duplex terminal channel. Type a message any time, even
 * while workers are busy. Prefix with "#thread " to address a specific thread,
 * e.g. "#pr-42 please also add tests".
 */
async function main() {
  const agent = await new SuperAgent({
    routerLLM: llmFromEnv("router"),
    workerLLM: llmFromEnv("worker"),
    environments: [new LocalEnvironment("local", process.cwd())],
    store: new FileStore(process.env.STATE_DIR ?? ".superagent-state"),
    onOutbound: (m) => console.log(`\n[agent → ${m.channel}:${m.threadKey}] ${m.text}\n`),
  }).init();
  const watchdog = new Watchdog(agent, { stallMs: 5 * 60_000, llm: llmFromEnv("watchdog"), onAlert: (a) => console.error(`[watchdog] ${a}`) });
  watchdog.start(60_000);

  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      await agent.runUntilIdle(10_000);
    } catch (e) {
      console.error(e);
    } finally {
      running = false;
    }
  };

  console.log("superOpenAgent CLI. Type messages; Ctrl+D to exit.");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const m = /^#(\S+)\s+(.*)$/.exec(line);
    void agent
      .ingest({ channel: "cli", source: "terminal", threadKey: m?.[1] ?? "cli-main", author: "user", text: m?.[2] ?? line, mentionsAgent: true })
      .then(() => pump());
  });
  rl.on("close", async () => {
    watchdog.stop();
    await agent.persist();
    process.exit(0);
  });
}

void main();
