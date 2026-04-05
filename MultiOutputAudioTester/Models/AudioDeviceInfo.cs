namespace MultiOutputAudioTester.Models;

public sealed class AudioDeviceInfo
{
    public string Id { get; init; } = string.Empty;

    public string Name { get; init; } = string.Empty;

    public string? Alias { get; init; }

    public string IconType { get; init; } = "auto";

    public string State { get; init; } = string.Empty;

    public bool IsActive { get; init; }

    public string EffectiveName => string.IsNullOrWhiteSpace(Alias) ? Name : Alias;

    public string DisplayName => $"{EffectiveName} [{State}]";

    public override string ToString()
    {
        return DisplayName;
    }
}
