# MultiAudio Nouva Web Widget

`WebUI` is a Windows-only [ASP.NET Core](https://dotnet.microsoft.com/en-us/apps/aspnet) wrapper around the existing `MultiOutputAudioTester` backend for `MultiAudio Nouva`. It keeps the audio engine local and hidden, then exposes a polished browser control surface at `http://localhost:5057`.

## Current Routes

- `/`, `/index.html`, `/astra`, `/astra/`: Astra (default).
- `/legacy/`: historical control-surface archive.
- `/legacy/v1/`, `/legacy/v2/`, `/legacy/v3/`: preserved versions.
- Other archived pages: `launch`, `launch-neo`, `v2-Control`, `v2-Dashboard`,
  `v2-Codex`, `v2-Tactile`, and `original`, beneath `/legacy/`.
- Original version and launch URLs remain compatible, including absolute asset links.

Astra has no external browser dependencies. HTML, CSS and JavaScript live in `wwwroot/astra/`.
The historical pages retain their existing behavior and share the same API.

## Dependencies

- [.NET 8 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/8.0) to build and run the app locally
- [ASP.NET Core](https://dotnet.microsoft.com/en-us/apps/aspnet), included with the .NET 8 SDK/runtime
- [NAudio on NuGet](https://www.nuget.org/packages/NAudio/) through the referenced backend project
- [Inno Setup 6](https://jrsoftware.org/isdl.php) if you want to build the Windows installer

## What this gives you

- Reuses the current audio engine, device enumeration, config persistence, live auto-sync, and calibration services.
- Removes the WPF window from the control loop. The browser becomes the control surface.
- Adds multiple route styles instead of a single page:
  - `Astra` (default)
  - `v1 Legacy`
  - `v2 Control`
  - `v2 Dashboard`
  - `v2-Codex`
  - `v2-Tactile`
- Enforces safer live editing than the current desktop UI:
  - Capture input, test tone mode, and playback-device assignments can only change while stopped.
  - Volume, delay, master route, master volume, calibration mic, and auto-sync settings remain adjustable while running.
- Adds device customization for playback endpoints:
  - alias / custom speaker name
  - explicit icon type override
  - config-backed persistence

## Architecture

- `Program.cs`
  - Hosts the local web app and maps JSON API endpoints.
- `Services/AudioControlService.cs`
  - Replaces the WPF view-model role for browser usage.
  - Manages in-memory state, validation, config saving, start/stop, calibration, logs, and live output metrics.
- `wwwroot/astra/`
  - Default Astra control surface.
- `wwwroot/legacy/`
  - Archive index and preserved historical control surfaces.
- `wwwroot/device-icons/`
  - shared SVG icon assets used by launch and dashboard surfaces.

## API surface

- `GET /api/state`
- `GET /api/telemetry-state`
- `GET /api/events`
- `GET /api/telemetry`
- `POST /api/start`
- `POST /api/stop`
- `POST /api/calibrate`
- `POST /api/calibrate/cancel`
- `POST /api/refresh-devices`
- `POST /api/open-config-folder`
- `POST /api/outputs`
- `POST /api/outputs/{slotIndex}/mute`
- `POST /api/outputs/{slotIndex}/solo`
- `POST /api/outputs/{slotIndex}/ping`
- `DELETE /api/outputs/{slotIndex}`
- `PUT /api/settings`
- `PUT /api/outputs/{slotIndex}`
- `PUT /api/device-profiles`

## Device Customization

Supported routes expose a `Customize` action on the selected output. That popup lets you store:

- `Custom Name`
- `Device Type`
  - `auto`
  - `speaker`
  - `bookshelf`
  - `soundbar`
  - `portable`
  - `headphones`

This is persisted into the shared local config:

```json
"DeviceProfiles": {
  "{device-id}": {
    "Alias": "Desk Monitors",
    "IconType": "bookshelf"
  }
}
```

The same device-profile data also drives icon selection in the routes that use the SVG device icon system.

## Run

From the repository root:

```powershell
dotnet run --project .\WebUI\WebUI.csproj
```

Then open:

```text
http://localhost:5057
```

The app now opens the default browser automatically on startup.

To suppress browser auto-open for automation or headless runs:

```powershell
$env:MULTIAUDIO_NO_BROWSER=1
dotnet run --project .\WebUI\WebUI.csproj
```

To force a specific port:

```powershell
$env:MULTIAUDIO_WEBUI_PORT=5057
dotnet run --project .\WebUI\WebUI.csproj
```

## Packaging

Portable build:

```powershell
.\scripts\publish-portable.ps1
```

Versioned portable build:

```powershell
.\scripts\publish-portable.ps1 -Version 0.75.0
```

Installer build with Inno Setup 6:

```powershell
.\scripts\build-installer.ps1 -Version 0.75.0
```

Installer dependency:

- [Inno Setup 6](https://jrsoftware.org/isdl.php)

Outputs:

- Portable app folder:
  `dist\portable\win-x64\app`
- Portable zip:
  `dist\portable\MultiAudioNouva-<version>-win-x64-portable.zip`
- Installer:
  `dist\installer\MultiAudioNouva-<version>-setup.exe`

## Cleanup Helpers

WebUI temp/build cleanup:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\cleanup-webui-temp.ps1 -IncludeArtifactsCache
```

WPF-generated obj cleanup:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\cleanup-wpf-obj.ps1
```

Include release-generated WPF obj too:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\cleanup-wpf-obj.ps1 -IncludeRelease
```

These scripts are intentionally restricted to generated temp/build artifacts and do not target live source files or `wwwroot`.

## Astra verification

Build: `dotnet build WebUI/WebUI.csproj` from the repository root.

Use an isolated configuration for tests (the ordinary app still uses the existing LocalAppData config):

```powershell
$env:MULTIAUDIO_CONFIG_PATH = "$PWD/artifacts/astra-test/config.json"
$env:MULTIAUDIO_WEBUI_PORT = '5099'
$env:MULTIAUDIO_NO_BROWSER = '1'
dotnet run --project WebUI/WebUI.csproj --no-launch-profile
```

In another terminal, run `python tests/astra_api_smoke.py http://localhost:5099`.
This checks routing, rejected requests, output lifecycle, duplicate assignment rollback,
and mute/solo state. It changes only the test host's route state and does not start playback.
`GET /api/health` returns a lightweight host-health response.

Astra accepts both historical SSE property casing and REST JSON casing. Meter updates use
the separate telemetry stream, avoiding rebuilding focused controls on each audio frame.
Actual speaker latency, audible quality and room-microphone calibration need hardware listening tests.

## Astra studio controls

The default listening room arranges outputs around the source. Select a speaker or channel number to edit it in the adjacent controls. Switch to Mixing console for simultaneous channel strips with vertical faders. Source setup, synchronization, session logs and signal history open from the left tool rail. Transport and master volume remain visible.

Device positions represent routing layout, not physical distances. Connections animate only when fresh telemetry reports signal activity. The 30-second graph displays measured peak amplitude in dBFS and supports hold and peak reset.

Keyboard shortcuts: Space starts/stops, D dims/restores, and / focuses output search. Shortcuts do not intercept typing or open dialogs.

## Four-beat synchronization check

Enable the four-beat tick while streaming. Each output keeps a fixed short click: 1 low (700 Hz), 2 mid (1400 Hz), 3 high (2800 Hz), 4 bright (4200 Hz); voices repeat after four outputs. Beats occur once a second, with a stronger first beat every four seconds.

Compare two speakers by muting the others. The click heard first identifies the earlier speaker: add delay to it in 10 ms steps, then 1 ms until the clicks merge. Align the strong first beats to avoid whole-second mismatch. Four-second offsets remain ambiguous.

All clicks share one source-frame clock and enter each output before delay and volume processing. Re-enabling restarts at beat 1. The screen shows source generation, not acoustic arrival. Legacy tick controls use the same engine sound.

Verification:

- `node --test --test-isolation=none tests/astra_visualizer.test.mjs`
- `dotnet run --project tests/SyncTickTests/SyncTickTests.csproj -- artifacts/astra-test/four-beat-sync.wav`
- `python tests/astra_sync_engine.py http://localhost:5100` against a separate idle test host with `MULTIAUDIO_CONFIG_PATH` set to disposable test data. This requires a VB-Audio virtual endpoint and uses zero output/master volume.

See [backend review](../docs/astra-backend-review.md) for future reliability and telemetry improvements.

### Output count and sync sounds

Saved configurations now preserve any output count of one or more; reducing to two outputs no longer restores a third on restart. Fresh installs still start with three empty routes.

Remove the selected output using the visible **Remove output** action above the channel picker, or the × at the top of its channel strip. Stop streaming before adding or removing outputs.

The workspace header exposes two independent controls:

- **Sync noise: ON/OFF** disables/enables the acoustic auto-sync markers and measurement mode. Turning it off leaves manual delays and the four-beat tick available.
- **4-beat tick / Stop tick** starts/stops the audible four-tone check while streaming.

Muting marker noise clears its internal delay line so queued marker samples do not continue into new audio blocks. Audio already buffered by an output device can still take time to finish playing.

Regression checks: `dotnet run --project tests/AudioControlTests/AudioControlTests.csproj`.
