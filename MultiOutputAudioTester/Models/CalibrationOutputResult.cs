namespace MultiOutputAudioTester.Models;

public sealed class CalibrationOutputResult
{
    public int SlotIndex { get; init; }

    public string DeviceName { get; init; } = string.Empty;

    public bool Succeeded { get; init; }

    public double MeasuredLatencyMilliseconds { get; set; }

    public int SuggestedDelayMilliseconds { get; set; }

    public double ConfidenceScore { get; init; }

    public string Message { get; init; } = string.Empty;
}
