using System.IO;
using MultiOutputAudioTester.Models;

namespace MultiOutputAudioTester.Services;

public sealed class AppLogger
{
    private readonly object _sync = new();
    private readonly string _logFilePath;

    public AppLogger()
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MultiOutputAudioTester",
            "logs");

        Directory.CreateDirectory(root);
        _logFilePath = Path.Combine(root, $"session-{DateTime.Now:yyyyMMdd-HHmmss}.log");
    }

    public event EventHandler<LogEntry>? EntryLogged;

    public void Info(string message) => Write("INFO", message);

    public void Warn(string message) => Write("WARN", message);

    public void Error(string message, Exception? exception = null)
    {
        var fullMessage = exception is null
            ? message
            : $"{message} | {exception.GetType().Name}: {exception.Message}";

        Write("ERROR", fullMessage);
    }

    private void Write(string level, string message)
    {
        var entry = new LogEntry
        {
            Timestamp = DateTime.Now,
            Level = level,
            Message = message
        };

        lock (_sync)
        {
            File.AppendAllLines(_logFilePath, [entry.DisplayText]);
        }

        EntryLogged?.Invoke(this, entry);
    }
}
