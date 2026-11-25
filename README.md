# Timebit

Timebit is a Chrome extension for Pomodoro, Cascade, and finish-by study sessions. It uses plain HTML, CSS, and JavaScript and needs no build step.

## Load the extension

1. Open `chrome://extensions` in Chrome 127 or later.
2. Turn on **Developer mode**, choose **Load unpacked**, and select the `extension` directory.
3. Open Timebit from the extensions menu. Choose a mode on the timer, or use the gear to open **Settings**. From there, open **Timing modes**, **Manage tasks**, or **Notifications & sound**.

Every phase waits for **Start**. **Reset** restores the current phase's original duration. Saving settings updates a ready phase and future phases. Running and paused phases retain their original duration. Changing modes queues the first study phase in the new mode.

Pin Timebit from Chrome’s Extensions menu to see minutes remaining. The badge shows `Ⅱ` while paused and `0` after a block finishes. Hover over the icon for the current phase and remaining time as of the last refresh.

Timebit saves the timer deadline and settings locally. The Chrome service worker finishes the current phase in the background, even with the popup closed. If Chrome is closed or the computer sleeps past the deadline, Timebit catches up when Chrome resumes and leaves the next phase waiting for Start. Chrome may delay background alarms, particularly for very short test durations.

When a study block ends, Timebit saves the waiting break, plays a soft chime, and tries to open the check-in if Chrome is in focus. If Chrome can't open it, Timebit uses the desktop notification setting. Clicking a notification opens the timer. The break starts when you press **Start**.

Closing the check-in keeps your tasks and the waiting break. Reopen Timebit to pick up the check-in. Otherwise, the toolbar popup remembers your page during the Chrome session. When a break ends, Timebit leaves the next study block ready to start and sends a notification if enabled.

After a study block or break ends, the timer shows overtime as a negative countdown. It continues from the original deadline across sleep and restarts. The next phase waits for **Start**. Starting, skipping, or resetting the queued phase clears overtime.

The timer footer shows **Today** study time from this update onward. It includes time spent studying before a pause, skip, or reset. Breaks, pauses, waiting time, and overtime are excluded. A study block that crosses midnight contributes only its time within the current local day.

Use **Notifications & sound** in the gear menu to control desktop notifications, automatic check-ins, and sound. Automatic check-ins and notifications are enabled by default. You can preview the chime, mute it, or set its volume from 0 to 100%. Chrome and your system settings control whether desktop notifications appear.

Add tasks below the timer controls. The same checklist is available after a study block finishes and on the **Manage tasks** page, which also has **Clear completed** and **Clear all**. Timebit saves changes immediately on this device, including when you change modes or restart Chrome.

To smoke-test recovery, use a short study block and close the popup or quit Chrome before it ends. After the deadline, reopen Chrome and check that the next break is waiting for Start. Pressing Pause before you quit should instead preserve the time that was left.

## Plan a session

1. Choose **Finish-by plan** from the timer's mode selector, or **Plan your time** from Settings.
2. Pick a finish time later today, select a pattern, and enter your preferred study and break lengths. The preview shows how much time is available and how the plan divides it.
3. Select **Use this plan**, then press **Start** for each phase.

The finish time stays fixed when you wait, pause, or skip. Timebit adjusts the remaining phases and can replace a break with a final study block if the break no longer fits. That study still waits for Start. A new plan and any newly generated phase require at least one minute. Use **Edit plan** to replace the schedule, or select a preset to return to its regular timer.

## Block distractions

1. Open **Settings → Distraction sites** to edit the list. YouTube, Instagram, and Reddit are included at first. A saved domain covers that domain and its subdomains.
2. Turn on **Block distractions** and grant Chrome access to the listed domains. A site with missing access stays unblocked and shows a **Grant access** button.
3. Start a study block. Matching open tabs and new visits go to the focus page, where you can use your checklist or return to your last study tab. Pause, reset, finish the block, or take a break to browse normally again.

To keep a specific site available during study, remove it from the saved list. Existing focus pages update when blocking ends. The next visit to the site then loads normally.

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

If Playwright is already provided by your runtime, set `TIMEBIT_PLAYWRIGHT` to the absolute path to its `playwright/test` entry point. Set `TIMEBIT_EXTENSION` to the absolute path to an extracted build's `extension` folder to test the contents of a ZIP. The blocker tests use local sites and a temporary extension copy with a test host grant. To verify the native permission prompt manually, toggle blocking in the regular build and accept or deny the request.
