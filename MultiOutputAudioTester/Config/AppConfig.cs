using MultiOutputAudioTester.Models;

namespace MultiOutputAudioTester.Config;

public sealed class AppConfig
{
    public Dictionary<string, DeviceProfileConfig> DeviceProfiles { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public string? InputDeviceId { get; set; }

    public string? CalibrationInputDeviceId { get; set; }

    public bool UseTestTone { get; set; }

    public double MasterVolumePercent { get; set; } = 100;

    public AutoSyncSettings AutoSync { get; set; } = new();

    public List<OutputRouteConfig> Outputs { get; set; } = OutputRouteConfig.CreateDefaults();

    public void EnsureDefaults()
    {
        DeviceProfiles ??= new Dictionary<string, DeviceProfileConfig>(StringComparer.OrdinalIgnoreCase);
        DeviceProfiles = DeviceProfiles
            .Where(entry => !string.IsNullOrWhiteSpace(entry.Key))
            .ToDictionary(
                entry => entry.Key,
                entry =>
                {
                    var profile = entry.Value ?? new DeviceProfileConfig();
                    profile.EnsureDefaults();
                    return profile;
                },
                StringComparer.OrdinalIgnoreCase);

        MasterVolumePercent = Math.Clamp(MasterVolumePercent, 0, 100);
        AutoSync ??= new AutoSyncSettings();
        AutoSync.EnsureDefaults();
        Outputs = OutputRouteConfig.Normalize(Outputs);
    }
}
