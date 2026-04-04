# Multi Output Audio Tester

`MultiOutputAudioTester` is a Windows-only WPF desktop app for early local testing of one captured audio source duplicated to three playback devices at once. The v1 target is practicality: choose a recording endpoint like Stereo Mix or a Virtual Audio Cable input, choose exactly three playback devices, then stream the same normalized live audio to all three while tuning delay and volume per output.

## Stack

- Windows desktop app
- C# / .NET 8
- WPF UI
- NAudio for WASAPI capture, playback, metering, and sample-provider plumbing

## Project layout

```text
MultiOutputAudioTester.sln
MultiOutputAudioTester/
  App.xaml
  MainWindow.xaml
  MultiOutputAudioTester.csproj
  Config/
  Helpers/
  Models/
  Services/
  ViewModels/
README.md
```

## What v1 does

- Enumerates Windows recording and playback devices.
- Lets you pick one input and as many playback targets as you want to test.
- Captures live audio from the chosen recording endpoint in shared mode.
- Normalizes the stream to internal `48 kHz stereo IEEE float`.
- Fans the normalized stream out to three independent playback pipelines.
- Provides per-output volume control.
- Provides a global master output volume slider on top of the per-route volume controls.
- Provides per-output manual delay control from `0` to `2000 ms`.
- Lets you add and remove output routes while the stream is stopped.
- Preserves the existing mic-based calibration mode as a fallback/debug tool.
- Adds a live background auto-sync system that runs while music is already playing.
- Injects a very low-level unique marker into every output route so a single room microphone can estimate each speaker independently.
- Treats one route as the timing master and continuously smooths per-route arrival estimates, coarse auto-delay, confidence, and tiny drift-correction playback-rate trims.
- Keeps the existing per-output manual delay and volume controls available as fallback/override tools.
- Shows a capture meter plus per-output meters and buffer status.
- Saves the selected devices and delay/volume settings to a JSON config file.
- Includes a built-in 440 Hz test tone mode to verify routing even before live capture is working.

## Dependencies

- Windows 10/11
- .NET 8 SDK or newer SDK with the .NET 8 desktop runtime installed
- Visual Studio 2022 or newer with `.NET desktop development`, or the `dotnet` CLI
- Internet access for the first NuGet restore so `NAudio` can be downloaded
- Your existing capture setup:
  - Stereo Mix enabled in Windows if you want to capture system audio that way
  - or Virtual Audio Cable / VB-CABLE already installed and routed on your machine

## Restore, build, and run

From `C:\Wizardry\Codex\MultiAudioStreamer`:

```powershell
dotnet restore .\MultiOutputAudioTester.sln
dotnet build .\MultiOutputAudioTester.sln
dotnet run --project .\MultiOutputAudioTester\MultiOutputAudioTester.csproj
```

From Visual Studio:

1. Open `MultiOutputAudioTester.sln`.
2. Let NuGet restore packages.
3. Set `MultiOutputAudioTester` as the startup project if needed.
4. Build and run with `F5` or `Ctrl+F5`.

## How to test with Stereo Mix or Virtual Audio Cable

### Option A: Stereo Mix

1. Open Windows Sound settings and make sure `Stereo Mix` is enabled in the recording devices list.
2. Route your PC audio normally so the recording endpoint sees it.
3. In the app, choose `Stereo Mix` as the capture source.
4. Choose three different playback devices.
5. Click `Start`.
6. Play audio on the PC and watch the capture meter move.

### Option B: Virtual Audio Cable

1. Route your test audio into your Virtual Audio Cable input/output pair.
2. Choose the relevant cable recording endpoint in the app.
3. Choose the Bluetooth speakers, wired output, or any additional devices you want to include as playback routes.
4. Use `Add Output` if you need more routes.
5. Click `Start`.
6. Confirm each route meter moves and each device is audible.

### Built-in test tone mode

Use the `Use built-in 440 Hz test tone instead of live capture` checkbox when you want to verify only the output side first.

Suggested order:

1. Select the playback devices you want to test.
2. Enable test tone mode.
3. Start streaming.
4. Confirm each route is audible and independently adjustable.
5. Disable test tone mode and move to live capture.

## Live auto-sync

The app now has a background live auto-sync path that starts automatically with playback when:

- `Enable hidden live auto-sync while streaming` is checked
- a real room microphone is selected
- playback is running

What it does:

- The selected timing-master route remains the reference route in the UI.
- Every output gets a very low-level unique marker mixed into that route while streaming.
- The room microphone continuously listens while the music is playing.
- The app correlates the room mic against each route’s marker independently.
- It smooths those arrival estimates instead of reacting to raw single-window measurements.
- It applies coarse auto-delay to keep faster routes aligned to the slowest currently trusted arrival.
- It applies tiny playback-rate trims to non-master routes to reduce Bluetooth drift over time.
- If confidence drops, it holds the previous correction instead of hunting wildly.

What you can tune:

- `Marker Level`: raise this if lock is weak; lower it if you can hear the marker.
- `Manual Delay`: kept as a fallback/base offset if you want to bias a route manually.
- `Master` checkbox on each route: choose which route acts as the timing anchor in diagnostics and drift control.

What to watch in the UI:

- `Auto-Sync` status on each route card
- `Arrival`
- `Auto Delay`
- `Effective`
- `Sync Rate`
- `Confidence`
- `Room Mic Meter`

Important physical limitation:

- Sync is optimized near the room microphone position, not uniformly across the entire room.
- The system still cannot advance a slow Bluetooth speaker in time, so the practical target is the slowest trusted arrival.
- The wired route can still be the logical timing master for drift tracking while also receiving positive coarse delay if it is physically the earliest path.

### Auto calibration mode

The app now includes a practical v1.1 calibration flow:

1. Select a real microphone in the `Calibration Microphone` dropdown.
2. Put the microphone at the listening position.
3. Keep the room quiet.
4. Click `Run Calibration`.
5. The app calibrates every configured output route, one route at a time.
6. The app ignores the currently applied delay sliders during calibration and plays directly to each output as if every route were at `0 ms`.
7. Each route plays one sacrificial wake burst first, then a separate two-burst broadband measurement packet several times.
8. Each playback attempt is captured and analyzed independently, so one weak route does not poison the rest of the run.
9. The app keeps the cluster of attempts that agree with each other and uses the median of that stable cluster for the suggested delay.
9. Fine-trim by ear afterward if needed.

Detection note:
- The calibrator now uses a sacrificial wake burst followed by a two-burst measurement pattern, which is more reliable on routes that sleep through the first emitted click.
- The detector now scores the full measured burst pair instead of latching onto the first acceptable spike, which should reduce offset misses when there is stray early energy in the capture window.
- Each calibration run now uses isolated per-attempt capture windows plus a stable-cluster median, which should reduce jumpiness between runs and reject obvious outliers.

If streaming is already live when you run calibration:

- The app pauses the live stream automatically.
- The outputs switch over to calibration audio.
- Suggested delay values are applied.
- The live stream is started again automatically with the updated delays.

Important notes:

- Use a physical microphone, headset mic, or USB mic for calibration.
- Do not use Stereo Mix or your Virtual Audio Cable as the calibration input. Those do not measure acoustic speaker arrival.
- Every calibration run now saves diagnostics under `%LocalAppData%\MultiOutputAudioTester\diagnostics\` including per-attempt `O#-S#-capture.wav` files, per-attempt analysis text files, and a `markers.txt` / `summary.txt` pair for troubleshooting.
- Calibration estimates relative offset well, but it does not replace long-term drift correction.

### Drift correction

The app now applies lightweight drift correction on every output route:

- Each route watches its own buffer depth.
- The app keeps each route near a target buffer level.
- It makes tiny playback-rate nudges, shown in the route status as `Drift: 1.0000x`.
- If one route runs too close to empty, the app now pauses all routes briefly and re-primes them together instead of letting a single route drift out of sync on its own.
- This is meant to reduce slow sync wander over longer playback sessions without obvious artifacts.

Notes:

- The correction range is intentionally small so it stays subtle.
- Output playback now waits for a short initial buffer fill before starting, which helps reduce startup clicks and rough artifact noise.
- Output playback now uses a deeper startup buffer than earlier builds, trading a bit more latency for better route stability.
- Drift correction now ramps more conservatively to reduce audible modulation artifacts.
- It improves long-session stability, but it is not a full professional clock-sync system.
- If a Bluetooth device glitches badly or reconnects, you may still need to stop and restart.

## Manual delay tuning

Bluetooth and wired outputs will not line up automatically in v1.

Recommended tuning workflow:

1. Start with all three delays at `0 ms`.
2. Listen for which device arrives earliest.
3. Increase delay on the early device until the group sounds tighter.
4. The wired output often needs extra delay so it lands closer to slower Bluetooth speakers.
5. Make changes while streaming and listen for the best compromise.

## Layout notes

- The routing area uses a compact two-column board so you can see more outputs at once.
- Live logs sit in the top-right panel beside capture controls, so errors stay visible without taking over the main route board.
- The capture panel includes a master volume slider that trims all active routes together without changing the per-route volume balances.
- The capture panel now also includes the live auto-sync toggle, marker level control, room mic meter, and the shared room/calibration microphone selector.
- Each route card now shows whether it is the timing master plus its live auto-sync diagnostics.
- If you need more routes, click `Add Output`. If you want fewer, use the `Remove` button on a route card while stopped.

## Config file

The app stores local settings here:

```text
%LocalAppData%\MultiOutputAudioTester\config.json
```

The session log file is written under:

```text
%LocalAppData%\MultiOutputAudioTester\logs\
```

## How to verify each output is receiving audio

- Watch the capture meter move.
- Watch each output meter move.
- Temporarily lower volume on one route only and confirm only that device changes.
- Add a large delay like `500 ms` to one route and confirm only that route shifts.
- Use the built-in tone to isolate routing from capture issues.

## Troubleshooting

### No capture audio

- Confirm the selected input device is the actual Windows recording endpoint carrying audio.
- For Stereo Mix, verify it is enabled and not muted in Windows Sound control panel.
- For Virtual Audio Cable, confirm the source app is sending audio into the cable endpoint you selected.
- If the capture meter stays flat, use test tone mode to make sure output routing is not the problem.

### Start fails with a device-open error

- Another app may have opened the endpoint in a conflicting way.
- Close DAWs, conferencing tools, or utilities that may be using exclusive mode.
- Disconnect and reconnect the Bluetooth speaker, then refresh devices and try again.
- If one output route faults during startup or shutdown, the app now tries to isolate that route and continue cleaning up the rest instead of letting a single WASAPI/COM failure take down the whole stop path.

### Bluetooth device disconnects mid-stream

- v1 does not implement full hotplug recovery.
- Stop the stream, reconnect the device in Windows, refresh the device list, and start again.
- Check the log panel and `%LocalAppData%\MultiOutputAudioTester\logs\` for the failure reason.

### Echo, flam, or comb filtering

- The routes are out of alignment.
- Increase delay on the early device until the effect becomes less obvious.
- Expect the wired output to behave differently from Bluetooth outputs.

### Latency keeps drifting

- The app now applies live room-mic-based auto-sync plus small automatic drift correction, but unrelated hardware clocks can still wander under difficult conditions.
- If the log shows repeated `low buffered audio` warnings, the app may do a coordinated rebuffer to recover stability. That preserves alignment better than per-route recovery, but it can still be audible if the source device stalls repeatedly.
- Shared-mode playback across Bluetooth and wired endpoints is still not truly sample locked.
- Restarting the stream and re-running calibration may help during very long sessions.

### Calibration finds nothing

- Raise speaker volume temporarily and rerun.
- Move the microphone closer to the speakers or listening position.
- Reduce background noise and avoid talking during the burst sequence.
- Make sure the calibration input is a real microphone, not a virtual or loopback endpoint.
- Extremely quiet or low-latency wired routes can still be harder to detect if the microphone is too far away.
- If detection still looks wrong, inspect the latest `%LocalAppData%\MultiOutputAudioTester\diagnostics\calibration-*` folder and look at `capture.wav` against `markers.txt` to see whether the burst is actually visible at the expected time.
- Recent calibration logic now estimates noise floor from the quietest part of the captured window instead of only the start of the window, which helps when early route energy would otherwise inflate the threshold and hide a valid hit.

### Unsupported format or silence on one output

- Windows may expose different endpoint formats or channel layouts.
- The app normalizes to 48 kHz stereo float internally, but a particular endpoint can still reject startup or behave badly.
- Try changing the Windows device format in Sound settings to a common stereo format and retry.

## Honest v1 limitations

- Two Bluetooth speakers plus one wired output will not achieve sample-accurate sync in this version.
- The live auto-sync path improves coherence near the mic position, but it is still constrained by one room mic, room acoustics, shared-mode Windows timing, and Bluetooth instability.
- Manual delay is still kept as a fallback/debug control, and the calibration button remains available when you want a direct static offset estimate.
- Auto-sync uses low-level hidden markers plus smoothing and rate limiting; it is intentionally conservative to avoid audible pumping.
- Drift correction is intentionally conservative, so very long sessions or unstable Bluetooth links can still wander somewhat.
- Hotplug recovery is limited. Reconnects usually require a stop, refresh, and restart.
- Shared mode was chosen for compatibility, not lowest latency.

## Next steps after v1

- Stronger marker detection and smarter confidence gating under louder music and noisier rooms
- Better automatic latency measurement, repeated calibration passes, and confidence scoring
- Stronger per-device drift detection and smarter adaptive correction
- Better Bluetooth disconnect recovery and endpoint hotplug handling
- Improved resampling and format negotiation per output
- Route mute/solo controls and per-route diagnostics
- Optional latency presets for specific speaker combinations
