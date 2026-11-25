import { DEFAULT_SOUND_VOLUME } from "../core/modes.js";

const AUDIO_PAGE = "offscreen/audio.html";

export function createChimePlayer(api) {
  let preparing;

  async function ensureAudioDocument() {
    const contexts = await api.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [api.runtime.getURL(AUDIO_PAGE)],
    });
    if (contexts.length) return;
    // Chrome releases AUDIO_PLAYBACK documents after 30 seconds of silence.
    await api.offscreen.createDocument({
      url: AUDIO_PAGE,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play the study completion chime when the timer popup is closed.",
    });
  }

  return async (settings) => {
    const volume = settings.soundVolume ?? DEFAULT_SOUND_VOLUME;
    if (settings.soundMuted === true || volume === 0) return;

    preparing ??= ensureAudioDocument().finally(() => { preparing = undefined; });
    await preparing;

    const result = await api.runtime.sendMessage({ target: "timebit-audio", volume });
    if (!result?.playing) throw new Error(result?.error ?? "The audio document did not respond.");
  };
}
