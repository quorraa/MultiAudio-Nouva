# MultiAudio Nouva Web Widget

`WebUI` is a Windows-only [ASP.NET Core](https://dotnet.microsoft.com/en-us/apps/aspnet) wrapper around the existing `MultiOutputAudioTester` backend for `MultiAudio Nouva`. It keeps the audio engine local and hidden, then exposes a polished browser control surface at `http://localhost:5057`.

## Current Routes

- `/`
  - `Launch Deck`
  - current default route
- `/v1/`
  - `v1 Legacy`
- `/v2/`
  - `v2 Control`
- `/v2-Dashboard/`
  - `v2 Dashboard`
- `/v2-Codex/`
  - alternate route
- `/v2-Tactile/`
  - alternate route

All major routes now expose a unified route picker.

## Dependencies

- [.NET 8 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/8.0) to build and run the app locally
- [ASP.NET Core](https://dotnet.microsoft.com/en-us/apps/aspnet), included with the .NET 8 SDK/runtime
- [NAudio on NuGet](https://www.nuget.org/packages/NAudio/) through the referenced backend project
- [Inno Setup 6](https://jrsoftware.org/isdl.php) if you want to build the Windows installer

## What this gives you

- Reuses the current audio engine, device enumeration, config persistence, live auto-sync, and calibration services.
- Removes the WPF window from the control loop. The browser becomes the control surface.
- Adds multiple route styles instead of a single page:
  - `Launch Deck`
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
- `wwwroot/index.html`
  - Legacy root shell. The current default route is served from `wwwroot/launch/index.html`.
- `wwwroot/app.css`
  - Legacy root route styling.
- `wwwroot/app.js`
  - Legacy root route client.
- `wwwroot/launch/`
  - Current default launch deck route.
- `wwwroot/v2/`
  - `v2 Control`.
- `wwwroot/v2-Dashboard/`
  - `v2 Dashboard`.
- `wwwroot/v2-Codex/`
  - Codex alternate route.
- `wwwroot/v2-Tactile/`
  - tactile alternate route.
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
.\scripts\publish-portable.ps1 -Version 0.5.0
```

Installer build with Inno Setup 6:

```powershell
.\scripts\build-installer.ps1 -Version 0.5.0
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

## Recent Additions Since The Last README Update

- default route changed to `Launch Deck`
- `v1 Legacy` preserved separately
- `v2 Dashboard` separated from `v2 Control`
- shared SVG device icon system added
- playback-device alias/type customization added
- config-folder open actions added in the UI
- route picker unified across the main pages
- safe cleanup scripts added for stale generated build output

## Recommended next steps

If you want this to feel even more like a desktop widget later without changing the backend again, the best follow-up path is:

1. Keep this ASP.NET Core + browser UI as the source of truth.
2. Wrap it in a lightweight desktop shell only after the web flow feels right.
3. Preferred wrapper order:
   `Tauri` for a lighter native shell, then `Electron` only if you need broader desktop integration faster than weight matters.
