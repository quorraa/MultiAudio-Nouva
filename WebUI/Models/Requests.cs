using MultiOutputAudioTester.Models;

namespace WebUI.Models;

public sealed class MainSettingsUpdateRequest
{
    public string? SelectedInputDeviceId { get; init; }

    public string? SelectedCalibrationInputDeviceId { get; init; }

    public bool UseTestTone { get; init; }

    public double MasterVolumePercent { get; init; }

    public AutoSyncMode AutoSyncMode { get; init; }

    public double MarkerLevelPercent { get; init; }
}

public sealed class OutputUpdateRequest
{
    public string? SelectedDeviceId { get; init; }

    public double VolumePercent { get; init; }

    public int DelayMilliseconds { get; init; }

    public bool IsTimingMaster { get; init; }
}
