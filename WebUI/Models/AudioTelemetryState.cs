using MultiOutputAudioTester.Models;

namespace WebUI.Models;

public sealed class AudioTelemetryState
{
    public long TelemetryRevision { get; init; }

    public bool IsRunning { get; init; }

    public bool IsCalibrating { get; init; }

    public double CaptureLevel { get; init; }

    public double RoomMicLevel { get; init; }

    public string CaptureStatusText { get; init; } = "Idle";

    public string SessionStatusMessage { get; init; } = "Ready";

    public string CalibrationStatusMessage { get; init; } = "Calibration idle.";

    public string CalibrationProgressMessage { get; init; } = "Calibration idle.";

    public IReadOnlyList<OutputTelemetryState> Outputs { get; init; } = [];

    public IReadOnlyList<CalibrationTelemetryEntry> RecentCalibrationEntries { get; init; } = [];
}

public sealed class OutputTelemetryState
{
    public int SlotIndex { get; init; }

    public double MeterLevel { get; init; }

    public string StatusText { get; init; } = "Idle";

    public double AppliedVolumePercent { get; init; }

    public int DelayMilliseconds { get; init; }

    public int EffectiveDelayMilliseconds { get; init; }

    public double SyncConfidence { get; init; }

    public SyncLockState SyncLockState { get; init; } = SyncLockState.Disabled;

    public string SyncSummary { get; init; } = string.Empty;

    public bool IsMuted { get; init; }

    public bool IsSolo { get; init; }
}

public sealed class CalibrationTelemetryEntry
{
    public string Time { get; init; } = string.Empty;

    public string Text { get; init; } = string.Empty;

    public string Tone { get; init; } = "neutral";
}
