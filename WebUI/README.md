# MultiAudio Nouva Web Widget

`WebUI` is a Windows-only ASP.NET Core wrapper around the existing `MultiOutputAudioTester` backend for `MultiAudio Nouva`. It keeps the audio engine local and hidden, then exposes a polished browser control surface at `http://localhost:5057`.

## What this gives you

- Reuses the current audio engine, device enumeration, config persistence, live auto-sync, and calibration services.
- Removes the WPF window from the control loop. The browser becomes the control surface.
- Adds a widget-style UI with three visual modes:
  - `Constellation`:
    Recommended. Best functional + visual balance. Strong presentation without losing route density.
  - `Rack`:
    Best when you care more about seeing many outputs at once than presentation flair.
  - `Compact Dock`:
    Best for a second monitor or always-on mini control widget while another app is foregrounded.
- Enforces safer live editing than the current desktop UI:
  - Capture input, test tone mode, and playback-device assignments can only change while stopped.
  - Volume, delay, master route, master volume, calibration mic, and auto-sync settings remain adjustable while running.

## Architecture

- `Program.cs`
  - Hosts the local web app and maps JSON API endpoints.
- `Services/AudioControlService.cs`
  - Replaces the WPF view-model role for browser usage.
  - Manages in-memory state, validation, config saving, start/stop, calibration, logs, and live output metrics.
- `wwwroot/index.html`
  - Main browser shell.
- `wwwroot/app.css`
  - Responsive visual system and layout modes.
- `wwwroot/app.js`
  - Polling client, live rendering, command handling, and layout selection persistence.

## API surface

- `GET /api/state`
- `POST /api/start`
- `POST /api/stop`
- `POST /api/calibrate`
- `POST /api/refresh-devices`
- `POST /api/outputs`
- `DELETE /api/outputs/{slotIndex}`
- `PUT /api/settings`
- `PUT /api/outputs/{slotIndex}`

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

## Packaging

Portable build:

```powershell
.\scripts\publish-portable.ps1
```

Versioned portable build:

```powershell
.\scripts\publish-portable.ps1 -Version 0.1.0
```

Installer build with Inno Setup 6:

```powershell
.\scripts\build-installer.ps1 -Version 0.1.0
```

Outputs:

- Portable app folder:
  `dist\portable\win-x64\app`
- Portable zip:
  `dist\portable\MultiAudioNouva-<version>-win-x64-portable.zip`
- Installer:
  `dist\installer\MultiAudioNouva-<version>-setup.exe`

## Recommended next steps

If you want this to feel even more like a desktop widget later without changing the backend again, the best follow-up path is:

1. Keep this ASP.NET Core + browser UI as the source of truth.
2. Wrap it in a lightweight desktop shell only after the web flow feels right.
3. Preferred wrapper order:
   `Tauri` for a lighter native shell, then `Electron` only if you need broader desktop integration faster than weight matters.
