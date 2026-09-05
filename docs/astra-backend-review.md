# Backend improvements for Astra

This is a code-based review, not a measured latency or listening assessment. The frontend upgrade does not change the audio-processing backend.

## 1. Serialize engine and auto-sync lifecycle transitions

`AudioEngineService.UpdateAutoSyncSettings` starts and stops `LiveAutoSyncService` without awaiting the tasks. Rapid mode changes can overlap. Make this operation asynchronous and await it through the control service's operation gate. Track the requested generation so an earlier start cannot win after a later stop.

`AudioControlService.StopAsync` cancels calibration, but calibration's `finally` block can restore a previously running stream. Introduce a stopping state, await calibration completion, suppress stream restoration during shutdown, then stop audio and flush the final configuration. Test rapid Off/Control changes, microphone replacement, cancellation and shutdown during calibration.

## 2. Report and recover device changes

`DeviceService` enumerates endpoints on demand; the web control service refreshes them at startup and on explicit refresh. Subscribe to Windows endpoint notifications. Update availability without losing stored assignments. Define behavior for an unplugged timing master: stop, pause, or select a replacement explicitly. Reconnect with bounded retries and expose a clear recovery state.

Validate with unplug/replug, Bluetooth sleep/wake, and a changed default input during a session.

## 3. Measure timing and make buffering configurable

`AudioOutputPipeline` uses a 260 ms target buffer and 240 ms initial buffer for every output. Add validated per-device buffering profiles, keeping the current conservative defaults. Collect underrun/overflow counts, actual buffer history, rebuffer duration and rate-correction history before reducing those targets.

`RunTestToneAsync` generates 10 ms of samples followed by `Task.Delay(10)`. Work and scheduler delay accumulate on top of each interval. Measure long-run production against a monotonic clock and use elapsed-time pacing or an audio-clock-driven approach. Verify with a long-duration soak test before changing the pump or drift controller.

## 4. Give telemetry a stable session and time model

The existing bounded, drop-oldest subscriptions are a good starting point. Add a host-session ID, monotonic sample timestamp, heartbeat, and documented units. REST currently uses camelCase/string enums while SSE serializes with default casing/numeric enums. Version or normalize that contract while preserving the legacy clients.

Expose buffer depth, rate correction, rebuffer count and measured arrival on the light telemetry stream. Those would enable meaningful latency and stability plots. PCM/FFT data is not currently exposed: the new frontend correctly displays peak-level history, not a waveform or spectrum.

## 5. Make persistence failures visible and edits conflict-aware

`ConfigurationService.SaveAsync` logs failures and returns successfully, so an applied control change can look saved even when persistence failed. Return a result or raise a persistence-status event; expose saved/pending/failed status and retain a last-known-good backup. The current atomic writes protect a file replacement but do not coordinate separate processes sharing the same config.

Settings and output requests replace several fields at once. Two browser tabs can overwrite each other's recent edits. Add revision preconditions or patch-style updates and a useful conflict response. This also creates a reliable foundation for server-backed named scenes and atomic multi-output changes.

## Recommended order

1. Lifecycle/shutdown safety with deterministic concurrency tests.
2. Device notifications and recovery tests.
3. Telemetry timestamps and health counters.
4. Buffer profiles backed by soak-test measurements.
5. Persistence status, conflict-aware edits, and atomic scenes.
