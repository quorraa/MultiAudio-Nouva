using MultiOutputAudioTester.Models;

namespace WebUI.Models;

public sealed class AudioDashboardState
{
    public string AppTitle { get; init; } = "MultiAudio Web Widget";

    public long StateRevision { get; init; }

    public bool IsRunning { get; init; }

    public bool IsCalibrating { get; init; }

    public bool CanStart { get; init; }

    public bool CanStop { get; init; }

    public bool CanRefreshDevices { get; init; }

    public bool CanAddOutput { get; init; }

    public bool CanRunCalibration { get; init; }

    public bool CanEditTopology { get; init; }

    public string? SelectedInputDeviceId { get; init; }

    public string? SelectedCalibrationInputDeviceId { get; init; }

    public bool UseTestTone { get; init; }

    public double MasterVolumePercent { get; init; }

    public AutoSyncMode AutoSyncMode { get; init; }

    public double MarkerLevelPercent { get; init; }

    public double CaptureLevel { get; init; }

    public double RoomMicLevel { get; init; }

    public string CaptureStatusText { get; init; } = "Idle";

    public string SessionStatusMessage { get; init; } = "Ready";

    public string CalibrationStatusMessage { get; init; } = "Calibration idle.";

    public string CalibrationProgressMessage { get; init; } = "Calibration idle.";

    public string LastErrorMessage { get; init; } = string.Empty;

    public string ConfigPath { get; init; } = string.Empty;

    public bool AnySoloActive { get; init; }

    public int LockedOutputCount { get; init; }

    public int LowConfidenceOutputCount { get; init; }

    public int FaultedOutputCount { get; init; }

    public IReadOnlyList<AudioDeviceInfo> InputDevices { get; init; } = [];

    public IReadOnlyList<AudioDeviceInfo> PlaybackDevices { get; init; } = [];

    public IReadOnlyList<OutputRouteState> Outputs { get; init; } = [];

    public IReadOnlyList<LogEntry> LogEntries { get; init; } = [];

    public IReadOnlyList<LayoutOption> LayoutOptions { get; init; } = [];
}

public sealed class OutputRouteState
{
    public int SlotIndex { get; init; }

    public string? SelectedDeviceId { get; init; }

    public string SelectedDeviceName { get; init; } = "Unassigned";

    public double VolumePercent { get; init; } = 100;

    public double AppliedVolumePercent { get; init; }

    public int DelayMilliseconds { get; init; }

    public bool IsTimingMaster { get; init; }

    public bool IsMuted { get; init; }

    public bool IsSolo { get; init; }

    public double MeterLevel { get; init; }

    public string StatusText { get; init; } = "Idle";

    public double BufferedMilliseconds { get; init; }

    public double PlaybackRateRatio { get; init; } = 1.0;

    public double AutoSyncPlaybackRateRatio { get; init; } = 1.0;

    public int EffectiveDelayMilliseconds { get; init; }

    public int AutoDelayMilliseconds { get; init; }

    public double EstimatedArrivalMilliseconds { get; init; }

    public double SyncConfidence { get; init; }

    public double MarkerLevelPercent { get; init; }

    public SyncLockState SyncLockState { get; init; } = SyncLockState.Disabled;

    public string SyncStatusText { get; init; } = "Manual";

    public string SyncSummary { get; init; } = string.Empty;

    public bool CanRemove { get; init; }
}

public sealed class LayoutOption
{
    public string Id { get; init; } = string.Empty;

    public string Name { get; init; } = string.Empty;

    public string Summary { get; init; } = string.Empty;

    public bool IsRecommended { get; init; }
}
