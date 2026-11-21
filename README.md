# Timebit

Timebit is a Chrome extension for Pomodoro and Cascade study sessions. The Phase 1.2 build uses plain HTML, CSS, and JavaScript and needs no build step.

## Load the extension

1. Open `chrome://extensions` in Chrome 127 or later.
2. Turn on **Developer mode**, choose **Load unpacked**, and select the `extension` directory.
3. Open Timebit from the extensions menu. Choose a mode on the timer, or use the gear to edit either mode's durations.

Every phase waits for **Start**. **Reset** restores the current phase's original duration. Saving settings updates a ready phase and future phases. Running and paused phases retain their original duration. Changing modes queues the first study phase in the new mode.

Timebit saves the timer deadline and settings locally. The Chrome service worker finishes the current phase in the background, even with the popup closed. If the browser is closed or the computer sleeps past the deadline, Timebit catches up when Chrome resumes and leaves the next phase waiting for Start. Chrome may delay background alarms, particularly for very short test durations. Phase 1.3 adds visible toolbar countdown badges and desktop notifications.

To smoke-test recovery, use a short study block and close the popup or quit Chrome before it ends. After the deadline, reopen Chrome and check that the next break is waiting for Start. Pressing Pause before you quit should instead preserve the time that was left.

## Run the tests

With Node.js 22 or later, run the timer unit tests and mocked Chrome storage integration tests.

```sh
npm test
```

The browser suite uses an isolated profile in installed Google Chrome. It uses the Chrome DevTools Protocol to load the unpacked extension, so use a current Chrome build. Install Playwright for test use and run the browser suite.

```sh
npm install --no-save --package-lock=false playwright
npm run test:chrome
```

If Playwright is already provided by your runtime, set `TIMEBIT_PLAYWRIGHT` to the absolute path to its `playwright/test` entry point. The suite checks popup startup, icon sizes, both settings forms, persisted preferences, the full Cascade order, synchronization between open views, background completion, and browser restart recovery.
