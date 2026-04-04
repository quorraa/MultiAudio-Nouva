namespace MultiOutputAudioTester.Models;

public sealed class AutoSyncSettings
{
    public AutoSyncMode Mode { get; set; } = AutoSyncMode.MonitorOnly;

    public double MarkerLevelPercent { get; set; } = 1.6;

    public bool IsEnabled => Mode != AutoSyncMode.Off;

    public bool AllowsControl => Mode == AutoSyncMode.Control;

    public void EnsureDefaults()
    {
        MarkerLevelPercent = Math.Clamp(MarkerLevelPercent, 0, 5);
    }

    public AutoSyncSettings Clone()
    {
        return new AutoSyncSettings
        {
            Mode = Mode,
            MarkerLevelPercent = MarkerLevelPercent
        };
    }
}
