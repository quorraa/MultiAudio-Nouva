namespace MultiOutputAudioTester.Models;

public sealed class AudioDeviceInfo
{
    public string Id { get; init; } = string.Empty;

    public string Name { get; init; } = string.Empty;

    public string State { get; init; } = string.Empty;

    public bool IsActive { get; init; }

    public string DisplayName => $"{Name} [{State}]";

    public override string ToString()
    {
        return DisplayName;
    }
}
