import assert from "node:assert/strict";
import test from "node:test";
import { createChimePlayer } from "../extension/background/sound.js";

test("concurrent playback shares one offscreen document and mute and zero volume skip it", async () => {
  const messages = [];
  const documents = [];
  const play = createChimePlayer({
    runtime: {
      getURL: (path) => `chrome-extension://timebit/${path}`,
      async getContexts() { return documents; },
      async sendMessage(message) { messages.push(message); return { playing: true }; },
    },
    offscreen: { async createDocument(document) { documents.push(document); } },
  });

  await play({ soundMuted: true, soundVolume: 100 });
  await play({ soundVolume: 0 });
  assert.deepEqual(documents, []);
  assert.deepEqual(messages, []);
  await Promise.all([play({}), play({ soundVolume: 100 })]);
  await play({ soundVolume: 1 });
  assert.equal(documents.length, 1);
  assert.deepEqual(documents[0].reasons, ["AUDIO_PLAYBACK"]);
  assert.deepEqual(messages, [35, 100, 1].map((volume) => ({ target: "timebit-audio", volume })));
});

test("a failed offscreen creation can be retried by a later play request", async () => {
  let creations = 0;
  const play = createChimePlayer({
    runtime: {
      getURL: (path) => path,
      async getContexts() { return []; },
      async sendMessage() { return { playing: true }; },
    },
    offscreen: {
      async createDocument() {
        creations += 1;
        if (creations === 1) throw new Error("Offscreen document could not load");
      },
    },
  });
  await assert.rejects(play({}), /could not load/);
  await play({});
  assert.equal(creations, 2);
});
