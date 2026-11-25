# Timebit implementation plan

## Goal and delivery order

Build a Chrome Manifest V3 study extension with reliable background timing, a persistent checklist, a finish-by planner, and distraction-site redirects. Implement a working extension after each phase rather than building disconnected screens.

Use plain HTML, CSS, and JavaScript for Phases 1–5. Introduce React in Phase 6 while retaining the tested timer, scheduling, storage, and blocking logic.

After the Chrome Web Store release milestone, add a study analytics dashboard in Phase 7 and an opt-in leaderboard in Phase 8. Leave synchronized study parties as the final optional phase.

The later decisions in this conversation take precedence over the original overview and incidental details in generated images. In particular: all phases start manually; the planner uses a fixed deadline and a simple two-duration interface; tasks are back on the main timer with generous spacing; the selected palette is Graphite.

## Agreed product behaviour

| Area | Requirement |
| --- | --- |
| Default mode | Pomodoro: 25-minute study, 5-minute short break, 15-minute long break after every third completed study block. The long break replaces that short break. |
| Cascade | Study blocks of 50, 40, 30, 20, and 10 minutes. One configurable short-break duration applies between all study blocks; default 10 minutes. A 25-minute long break follows the final study block directly. |
| Repetition | Pomodoro continues indefinitely. After Cascade's long break, prepare the first study block again. Neither mode starts the next phase automatically. |
| Controls | Start, pause, resume, reset the current phase, and skip/fast-forward. Finishing or skipping prepares the next phase in a waiting state. Skipping never counts as completing a study block. |
| Customisation | Separate Pomodoro and Cascade settings pages. Cascade's study durations, shared short break, and long break are editable. |
| Sleep/restart | Running time continues according to elapsed wall-clock time. On return, complete at most the expired current phase once; leave the next phase awaiting Start. Paused time remains paused. |
| Overtime and daily total | From Phase 2.4, show a negative countdown after expiry while the next phase waits. Show today's elapsed study time at the bottom of the main timer. |
| Tasks | Add, edit, delete, complete, reopen, and explicitly clear tasks. Tasks and completion states survive phase changes and browser restarts. |
| Check-in | Show the checklist after study completes, play the configured soft chime, and offer the next break's Start button. Support a notification fallback. |
| Smart planner | Choose a local "Finish by" time and preferred study/break durations. Keep the deadline fixed and adjust remaining phases after delays, pauses, and manual starts. End with study, never a final break. |
| Blocking | An explicit "Block distractions" checkbox controls the feature. Block only while a study phase is actively running; allow browsing during pauses, breaks, and waiting states. |
| Exceptions | No temporary allow or bypass. To access a listed site during active blocking, remove it from the saved distraction list or disable blocking using its normal controls. |
| MVP scope | Local-first, single-user extension with a daily study total. Accounts, backend services, the analytics dashboard, leaderboards, and shared study sessions belong to post-release work. |

## Visual specification

Use the latest approved main timer and the subsequent Graphite suite as the visual target. Generated browser chrome is context, not part of the extension. Implement actual controls and layouts rather than embedding mockup screenshots.

Reference: [approved Graphite timer with spacious tasks](https://chatgpt.com/library?file_id=libfile_a5c631cef82c8191bc005049dc19d245&account_id=personal).

| Token/component | Specification |
| --- | --- |
| Popup background | Cool Graphite grey `#E9EDF2`. |
| Cards, task rows, inputs, buttons | Near-white `#F6F8FB`, fine cool-grey borders, restrained shadows. |
| Main accent | Near-black `#17191D`; body text `#20242B`; secondary fills/tracks around `#D5DDE7`. |
| Main typography | Original clean sans-serif appearance; use Inter or a close system sans-serif. Approximately 12–13 px body, 15–16 px page titles, 36–38 px countdown. |
| Completion heading | "Study block complete" in larger, bold Libre Baskerville, naturally wrapping onto two lines. No "A little progress" or "Ready when you are" copy. |
| Branding | Small black vector Timbit/doughnut-hole mark with one white curved highlight. Keep the icon in popup headers and the toolbar; omit the written Timebit wordmark from popup pages. |
| Timer ring | A single continuous black arc representing remaining time. Start full; shrink toward zero. At 18:42 of 25:00, show about 75% remaining. No segments, wedges, or decorative ticks. |
| Buttons | White/near-white fills with dark text and subtle outlines. Keep reset, pause/play, and skip icons simple. |
| Sound and toggles | Black active volume track and round slider thumb. On toggles use black circular knobs with pale tracks. |
| Website icons | Preserve YouTube red, Instagram's original gradient, and Reddit orange. Bundle assets locally. |
| Task spacing | Minimum 44–48 px row height, comfortable checkbox/label separation, and 8–12 px gaps. Long task labels wrap rather than overlap actions. |
| Popup dimensions | Target approximately 390–400 px wide and at most 600 px high. Use a compact timer and a scrollable task region for long lists; never shrink task rows to fit. |

The main timer includes tasks below its controls. Keep its Pomodoro selector and "Focus · Block 3 of 3" status at the original modest sizes. Show time studied today in the footer. A cumulative block count may appear on the completion check-in.

## Architecture and state contracts

### Separation of responsibilities

- **Pure domain modules:** phase sequencing, state transitions, remaining-time calculations, preference validation, and finite schedule generation. Accept the current time as an argument so tests need not wait in real time.
- **Service worker:** authoritative writer of shared timer/settings/task state; Chrome event handlers, alarm scheduling, toolbar badges, notifications, audio commands, and blocking reconciliation.
- **Popup and redirect views:** render state and send explicit commands. Re-render on storage changes. A visible-page interval may refresh countdown text, but must never drive completion or write the timer once per second.
- **Offscreen document:** play locally bundled audio when the popup is closed. Create one document as needed and release it after playback.

### Suggested initial structure

| Path | Purpose |
| --- | --- |
| `extension/manifest.json` | MV3 manifest, action, worker, permissions, icons, and redirect resource declarations. |
| `extension/background/service-worker.js` | Registers top-level event listeners and coordinates domain modules/adapters. |
| `extension/core/` | Timer, modes, planner, validation, state versioning, and message contracts. |
| `extension/services/` | Storage, alarms, badges, notifications, audio, and blocking adapters. |
| `extension/popup/` | HTML, shared CSS tokens, JavaScript views, and lightweight navigation. |
| `extension/redirect/` | Encouragement page and live timer/checklist rendering. |
| `extension/offscreen/` | Hidden audio document and playback message handler. |
| `extension/assets/` | Packaged icons, font files/licences, website icons, and chime. |
| `tests/` | Pure domain tests and mocked Chrome API integration tests. |
| `README.md` | Loading unpacked, manual verification, build/package instructions, and limitations. |

Keep the domain modules independent of DOM elements, React, and global Chrome objects so Phase 6 can reuse the timer logic.

### Persisted data

Store versioned JSON in `chrome.storage.local`:

- `settings`: mode-specific durations, selected mode, notification/check-in preferences, mute/volume, distraction domains, and blocking preference.
- `timer`: mode, phase, `ready | running | paused | finished` status, original phase duration, deadline timestamp for the current run, paused remaining duration, phase/run identifiers, Cascade position, Pomodoro progress since its long break, and total completed study blocks.
- `tasks`: stable ID, text, completion state, and creation/update timestamps.
- `planner`: selected base pattern, absolute finish timestamp, preferred durations, and finite remaining phases.
- `delivery`: a bounded record identifying the latest handled phase completion/alert attempt, so waking or reopening cannot repeat completion effects.

Use one serial command path in the worker to prevent racing popup commands and alarms. Reject stale commands/events by checking the current phase/run ID and expected timestamp. Task updates must not overwrite unrelated timer state. Persist meaningful transitions rather than every displayed second.

## Phase 1 — Timer MVP

### 1.1 Establish the extension and timing engine

- Create an unpackable MV3 extension, black toolbar icons, Graphite CSS tokens, and a basic timer popup. Set a compatible minimum Chrome version; Chrome 127 is a reasonable baseline for the planned popup API.
- Implement mode sequences and validated settings. Keep each mode's editing form on its own page. Validate finite, positive durations and a descending Cascade study sequence; show concise inline errors.
- Distinguish completed-study counts from positions in a mode. A skipped Pomodoro study does not bring the long break closer. Reset the Pomodoro long-break cycle when leaving its long break, including when it is skipped.
- Define reset as returning the current phase to its full duration in `ready` state. Changing mode prepares its first phase; preserve total completion counts and tasks. Duration edits apply to future phases without unexpectedly changing a running countdown.

### 1.2 Implement controls, background persistence, and recovery

- Start stores `endsAt = now + remainingDuration`; pause stores the remaining duration and clears completion alarms; resume creates a new run deadline. Never treat a worker global as durable state.
- Register worker listeners synchronously. Use `chrome.alarms` for phase completion and a periodic badge refresh; re-check required alarms when the worker starts and on browser startup.
- Reconcile overdue state before rendering or accepting a command. Complete only the current running phase, persist the next phase as ready, and do not simulate additional unattended phases.
- Support alarm delays: calculate remaining time from the saved timestamp, not the number of alarm callbacks. Browser/OS scheduling is not a second-accurate delivery guarantee.

### 1.3 Add toolbar feedback and verify the timer

- Show `ceil(remainingMs / 60000)` on the toolbar while running; use a paused indicator when paused and `0` after completion while the next phase waits. Include phase and exact remaining time in the tooltip. Give users a short pin-to-toolbar hint.
- Send desktop completion notifications according to preferences. Clicking an alert opens the relevant extension view.
- Verify both full default sequences, custom lengths, ready/running/paused controls, skipped phases, mode changes, storage restoration, popup closure, worker suspension, and delayed alarms. Use a packaged-extension smoke check because unpacked alarm timing can differ.

**Acceptance:** A timer started in the popup continues correctly after it closes. The third completed Pomodoro study queues a 15-minute break. Cascade's final study queues a 25-minute break, then its first study. Nothing starts without the user's Start action, and recovery never multiplies completed counts.

## Phase 2 — Checklist and completion check-in

### 2.1 Implement persistent task management and shared views

- Add spacious checklist rows to the main timer, the completion check-in, and a dedicated task-management page. All views use the same persisted tasks.
- Support add/edit/delete/complete/reopen plus explicit clear-completed/clear-all actions. Use inline editing or a small focused editor; preserve row spacing. Confirm clear-all within the UI because it removes the user's whole list.
- Save each change immediately and render task text safely as text. Preserve tasks through mode changes, resets, phase transitions, and restarts.

### 2.2 Implement the completion experience and sound

- After a study naturally completes, persist the completion and next waiting phase before attempting effects. Show the "Study block complete" check-in with tasks and the next break's Start/Skip controls.
- Attempt `chrome.action.openPopup()` when enabled. Do not force Chrome to the foreground or create unrelated windows; retain the check-in state and use the configured notification fallback if opening fails.
- Use `chrome.offscreen` with `AUDIO_PLAYBACK` to play the bundled chime independently of the popup. Add sound preview, persisted mute, and a 0–100% volume control. Avoid concurrent offscreen-document creation.
- Deduplicate completion handling and alert attempts using durable phase/run IDs. User notification settings and OS notification suppression must not prevent timer transitions.

### 2.3 Complete navigation and validate the checklist flow

- Provide timer, settings hub, task manager, mode overview/editors, and notifications/sound routes. Preserve the selected route where helpful, but open the pending check-in after completion.
- Keep break completion simple: notify and prepare the next study with a Start button. A task check-in is specifically associated with finishing study.
- Verify task updates from multiple open extension views, popup dismissal during check-in, duplicate alarm delivery, muted sound, failed popup opening, disabled notifications, and restart recovery.

### 2.4 Show overtime and today's study total

- When any study or break reaches zero, process completion once and persist the expired phase's deadline alongside the queued phase. Show overtime as a negative countdown such as `-02:13`, with an empty progress ring. Keep the next phase's label and Start control visible while overtime runs, and show overtime in the completion check-in if it opens. Compute the display from the saved deadline so it survives popup closure, sleep, and browser restart. Clear overtime when the user starts, skips, or resets the queued phase, or replaces the session. On the final phase of a plan, show overtime with the plan marked complete.
- Add a footer such as **Today · 1 hr 05 min studied** at the bottom of the main timer. Persist timestamped intervals of running study locally and include the in-progress interval in the displayed total. Count the time already spent studying even if the user skips or resets the rest of the block. Exclude breaks, pauses, time awaiting Start, and overtime. Clip each study interval to its scheduled end and count only its overlap with today's local calendar day, including for blocks that span midnight. Start tracking from this update and preserve the existing completed-block count.
- Verify overtime after study and break expiry, dismissal and reopening of the check-in, and sleep or restart with a delayed alarm. Confirm that the next phase stays ready, alerts fire at most once, and the total stays accurate across pause/resume, skip/reset, midnight, and restarts without counting an interval twice.

**Acceptance:** Tasks persist until cleared, and dismissing check-in preserves tasks and timer progress. A finished phase produces one completion, shows overtime, and leaves any queued phase waiting for Start. The main timer shows today's recorded study time, including partial study blocks.

## Phase 3 — Finish-by smart planner

### 3.1 Build the simplified deadline interface

- Use the current local time and a same-day "Finish by" time as the initial MVP input. Require an explicit future deadline; do not silently move a past time to tomorrow.
- Offer Pomodoro or Cascade as the base pattern and two editable preferred durations: Study and Break. For Cascade, the study preference can represent its starting study length while retaining the descending pattern.
- Show available time and a concise summary, then "Use this plan". Keep the accepted screen simple: no permanent phase-by-phase timeline or dense preview table. A compact total summary can be secondary if it fits comfortably.

### 3.2 Generate a finite schedule deterministically

- Generate local JavaScript phase descriptors; no AI/API service is needed. Reuse the same timer engine as preset modes.
- Fit phases into the available interval, preserve the shared break preference where practical, and adjust study lengths/block count as necessary. Do not append a final break or repeat a finished planned schedule.
- Start with the preferred pattern, reserve time for a final study, and redistribute the remainder into that study rather than leaving a trailing break. Include base-pattern long breaks only when another study fits afterwards.
- Use explicit bounds as implementation defaults: at least one minute for a newly generated phase, finite positive durations, and no zero-length phases. If less than one minute remains, explain that there is insufficient time rather than producing invalid phases. Test these defaults before relaxing them.
- Example target: 3:30–5:00 PM with preferred 25/5 can become 25 study, 5 break, 25 study, 5 break, 30 study. Total 90 minutes, ending in study.

### 3.3 Recalculate against the fixed deadline

- Store an absolute finish timestamp. Rebuild the remaining schedule before each manual Start and after a pause/resume or skip, using time actually left. Preserve already recorded completions.
- Keep the deadline fixed; manual waiting does not silently push it later. Shorten/remove later phases as needed, and never schedule the active phase past the deadline. If necessary, prepare a final study instead of an intervening break and tell the user that the plan changed.
- If the deadline has passed, finish the plan; do not start another phase. Recovery can complete the expired active phase once, without awarding unstarted blocks. Applying a new plan must explicitly replace the current schedule.
- Keep overtime display-only. It must neither extend the plan deadline nor change which phases fit before it.
- Unit-test short budgets, exact fits, long budgets, cascading preferences, pause/resume near the deadline, skips, clock changes, and restart restoration.

**Acceptance:** The plan ends on study and never schedules beyond the selected deadline. Changes in actual start times are reflected in the remaining plan, with all phase starts still manual.

## Phase 4 — Distraction-site blocking and redirect page

### 4.1 Implement the saved domain list and permissions

- Provide YouTube, Instagram, and Reddit presets plus custom domains, enable/disable controls, and removal. Normalise hosts, deduplicate entries, and handle subdomains without matching unrelated lookalike domains.
- Request optional access only for selected sites through a user gesture. Prefer `declarativeNetRequestWithHostAccess` and optional host permissions; avoid requesting broad browsing access merely to implement a small saved list.
- Keep the preference independent of active enforcement. An enabled checkbox means "block while actively studying," not "block all the time." If access is denied/revoked, show a concise status and keep the timer usable.

### 4.2 Drive redirects from the timer's authoritative state

- Enforce only when enabled, the current phase is study, its status is running, and `now < endsAt`. Clear enforcement for paused, ready, finished, and break states.
- Use `chrome.declarativeNetRequest` main-frame redirect rules targeting a bundled page declared in `web_accessible_resources`. Use session rules for temporary enforcement, then rebuild them from saved preferences and reconciled timer state on startup.
- Scan matching already-open tabs when study starts/resumes or the block list changes. Cover navigation/activation cases that declarative network rules alone do not retroactively handle. Use selected-site host access where possible instead of a blanket `tabs` permission.
- Reconcile rules after every transition, on startup, and when the redirect page requests state. Test expiry/recovery so stale rules cannot strand users after a session ends. Avoid redirect loops and exclude extension/browser pages.

### 4.3 Build the Graphite encouragement page and validate enforcement

- Create a full-tab Graphite screen with "Don't give up," the same live remaining-time arc, current tasks, and a return-to-study action. Match popup typography and spacious task rows; retain the black Timbit icon and omit the popup-style wordmark.
- Support task updates through the same worker commands. Safely track a last allowed study tab/destination for the return action; validate URLs and provide a safe fallback when no destination is available.
- Do not offer allow-once/temporary bypass. Explain that the user can remove a site from the saved list. When enforcement is no longer active, allow normal navigation and recover any stale redirect view.
- Verify selected domains/subdomains, existing tabs, unrelated domains, permission changes, pause/resume, short/long breaks, skip/reset, deadline expiry, restart, and history/cache/service-worker navigation behaviour.

**Acceptance:** Listed sites redirect during active study only. They are available while paused, taking a break, or waiting. Disabling/removing a site takes effect promptly, and there is no hidden one-off exception path.

## Phase 5 — Responsive notification timer tab

### 5.1 Give notification clicks a full-tab fallback

- Keep the toolbar popup as the first destination when Chrome can open it. When opening the popup fails, route the notification click to a dedicated timer tab or an explicit full-tab layout. The current fallback opens the fixed-width popup page in a browser tab, leaving the timer at the upper left.
- Reuse the existing timer, check-in, and task views with the same persisted state and service-worker commands. Show the pending completion check-in or next phase when appropriate. If the user has already moved on, show the current phase. Leave the next phase waiting for Start.
- Show the same overtime and daily study total in the full-tab timer as in the toolbar timer. Keep the queued phase's controls accessible when displaying overtime.

### 5.2 Scale the tab layout to the viewport

- Center the main content on desktop. Give the countdown, progress ring, and controls enough size and spacing for a browser tab, with a maximum content width to keep the layout readable on wide displays.
- Let the content fit narrow windows and scroll vertically at higher zoom. Keep the toolbar popup sized for Chrome’s popup constraints.
- Verify a notification click in desktop Chrome with the popup fallback triggered. Check the layout at a typical desktop width and in a narrow or zoomed window, including the ability to start the next phase and see the resulting state in the toolbar popup.

**Acceptance:** The notification fallback opens a centered, readable timer or check-in screen. The countdown and controls fit the viewport without horizontal clipping, and the popup and tab stay in sync.

## Phase 6 — React migration, polish, and release preparation

### 6.1 Migrate views without rewriting the engine

- Introduce React and a small local build setup. Migrate shared components for headers, navigation, duration inputs, timer ring/controls, task rows, mode cards, settings, check-in, planner, and redirect.
- Retain pure modules, message contracts, worker logic, and saved data. Add explicit storage migrations for schema changes. Check an upgrade from the vanilla MVP with real saved tasks and an active/paused timer.
- Bundle scripts, styles, fonts, icons, and audio locally. Keep the extension compatible with MV3 content security rules; do not load executable code or fonts from a remote CDN.

### 6.2 Finish the complete page suite and accessibility

- Cover ready/running/paused focus, short/long breaks and waiting next study, study completion check-in, settings hub, mode overview, separate Pomodoro/Cascade editors, finish-by planner, task manager, distraction list, notifications/sound, the responsive notification timer tab, and the full-tab redirect.
- Reproduce the selected Graphite design consistently. Keep task rows spacious, forms uncluttered, selectors at their accepted sizes, primary buttons light, progress/volume active fills black, on-toggle knobs black, and website brand icons coloured.
- Add visible keyboard focus, labels, accessible names for icon buttons, status announcements, readable contrast, sensible tab order, and reduced-motion support. Avoid announcing the countdown every second to screen readers.
- Verify at different browser zoom levels and display scaling. Scroll long task lists instead of exceeding popup limits. Preserve normal keyboard editing when the visible countdown refreshes.

### 6.3 Package and prepare the Chrome Web Store submission

- Run domain/integration checks and manually smoke-test a clean packaged build. Include real Chrome checks for service-worker suspension, audio, notifications, popup opening, permissions, and redirects; mocks alone are insufficient.
- Audit requested permissions against implemented features. Bundle icon sizes, licensed assets, screenshots, a concise listing, accurate local-data/privacy disclosures, version metadata, installation instructions, and a ZIP with `manifest.json` at its root. Exclude source-only files, tests, and secrets from the ZIP.
- Keep publishing separate from preparation: produce the reviewable package and submission material without automatically submitting the listing or publishing it.

**Acceptance:** The packaged build matches the approved suite, retains MVP data through upgrades, passes the core browser flows, and is ready for the user to review and submit.

## Phase 7 — Study analytics dashboard

1. Build a dedicated dashboard using the study intervals recorded in Phase 2.4. Show all-time study time, daily and weekly totals, average daily study time, and a trend chart with a date-range filter. Include zero-study days within the selected range in the average and show when tracking began.
2. Keep calculations local and use the same rules as the timer footer. Verify that the dashboard's total for today matches the timer, that intervals spanning midnight are apportioned correctly, and that an empty history has a clear empty state.

## Phase 8 — Study leaderboards

1. Add an opt-in friends leaderboard ranked by total eligible study time for the week. Use a shared weekly cutoff for everyone on the board and apply the same study-time rules as the personal total.
2. Add the account and sync support needed to share rankings. Share aggregate study totals and a display name with participating friends. Keep tasks and detailed study history private. Verify that retries cannot add time twice and that leaving the leaderboard stops sharing.

## Phase 9 — Optional synchronized study parties

1. Add invite-only rooms with a shared study and break schedule. Let the host start each phase manually and synchronize pause, resume, and skip across the room. Sync using shared timestamps so late joins, reconnects, and delayed messages converge on the same phase and countdown.
2. Record each participant's personal study time only for the portion they joined and tracked. Count overlapping study time once. Verify the behaviour when a friend joins mid-block, disconnects, or leaves, and when the host skips a phase.

## Validation strategy and completion rules

- Prefer meaningful deterministic tests of phase sequences, time calculations, counts, reconciliation, planner fitting, and domain matching. Do not wait through real 25-minute phases in automated tests.
- Mock Chrome boundaries for scheduling/clear operations, stale events, failed popup opening, permission denial, and rule reconciliation. Keep actual browser smoke checks for behaviours mocks cannot establish.
- After each phase, document completed behaviour, checks run, and remaining limitations in the README. Treat an unpackable demonstrable extension as the milestone; a screenshot alone is not implementation.
- Keep statistics to the daily total and the metrics defined for the post-release phases. Do not add other gamification, automatic phase starts, website bypasses, or dense planner previews without a new product decision.

## Official implementation references

- [Chrome alarms: timing, sleep, and persistence](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Chrome action: badges, popup sizing, and openPopup](https://developer.chrome.com/docs/extensions/reference/api/action)
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
- [Chrome offscreen documents and audio playback](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Declarative request rules and extension-page redirects](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)

Consult the current API reference during implementation, especially for alarm timing, popup availability, and redirect permissions. Keep timestamp reconciliation and user-visible fallback behaviour even when a newer browser version adds convenience APIs.
