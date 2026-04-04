namespace MultiOutputAudioTester.Models;

public sealed class LogEntry
{
    public DateTime Timestamp { get; init; } = DateTime.Now;

    public string Level { get; init; } = "INFO";

    public string Message { get; init; } = string.Empty;

    public string DisplayText => $"{Timestamp:HH:mm:ss} [{Level}] {Message}";
}
