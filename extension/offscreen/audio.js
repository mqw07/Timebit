const audio = document.querySelector("audio");

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "timebit-audio" || sender.id !== chrome.runtime.id) return;
  const { volume } = message;
  if (!Number.isInteger(volume) || volume < 1 || volume > 100) {
    reply({ error: "Invalid chime volume." });
    return;
  }

  audio.volume = volume / 100;
  audio.currentTime = 0;
  audio.play().then(
    () => reply({ playing: true }),
    (error) => reply({ error: error.message }),
  );
  return true;
});
