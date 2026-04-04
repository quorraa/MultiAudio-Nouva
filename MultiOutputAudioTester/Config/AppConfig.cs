using MultiOutputAudioTester.Models;

namespace MultiOutputAudioTester.Config;

public sealed class AppConfig
{
    public string? InputDeviceId { get; set; }

    public string? CalibrationInputDeviceId { get; set; }

    public bool UseTestTone { get; set; }

    public double MasterVolumePercent { get; set; } = 100;

    public AutoSyncSettings AutoSync { get; set; } = new();

    public List<OutputRouteConfig> Outputs { get; set; } = OutputRouteConfig.CreateDefaults();

    public void EnsureDefaults()
    {
        MasterVolumePercent = Math.Clamp(MasterVolumePercent, 0, 100);
        AutoSync ??= new AutoSyncSettings();
        AutoSync.EnsureDefaults();
        Outputs = OutputRouteConfig.Normalize(Outputs);
    }
}
