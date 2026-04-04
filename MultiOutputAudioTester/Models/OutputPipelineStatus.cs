namespace MultiOutputAudioTester.Models;

public sealed class OutputPipelineStatus
{
    public int SlotIndex { get; init; }

    public double MeterLevel { get; init; }

    public double BufferedMilliseconds { get; init; }

    public double PlaybackRateRatio { get; init; }

    public double AutoSyncPlaybackRateRatio { get; init; }

    public int EffectiveDelayMilliseconds { get; init; }

    public int AutoDelayMilliseconds { get; init; }

    public double EstimatedArrivalMilliseconds { get; init; }

    public double SyncConfidence { get; init; }

    public double MarkerLevelPercent { get; init; }

    public bool IsTimingMaster { get; init; }

    public SyncLockState SyncLockState { get; init; }

    public string SyncStatusText { get; init; } = string.Empty;

    public string StatusText { get; init; } = string.Empty;
}
