using System.IO;
using System.Text.Json;
using MultiOutputAudioTester.Config;

namespace MultiOutputAudioTester.Services;

public sealed class ConfigurationService
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true
    };

    private readonly AppLogger _logger;
    private readonly SemaphoreSlim _saveGate = new(1, 1);

    public ConfigurationService(AppLogger logger)
    {
        _logger = logger;
        ConfigPath = Environment.GetEnvironmentVariable("MULTIAUDIO_CONFIG_PATH") ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MultiOutputAudioTester",
            "config.json");
    }

    public string ConfigPath { get; }

    public async Task<AppConfig> LoadAsync()
    {
        try
        {
            var directory = Path.GetDirectoryName(ConfigPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            if (!File.Exists(ConfigPath))
            {
                var defaultConfig = new AppConfig();
                defaultConfig.EnsureDefaults();
                await SaveAsync(defaultConfig);
                return defaultConfig;
            }

            await using var stream = File.OpenRead(ConfigPath);
            var config = await JsonSerializer.DeserializeAsync<AppConfig>(stream, SerializerOptions) ?? new AppConfig();
            config.EnsureDefaults();
            return config;
        }
        catch (Exception ex)
        {
            _logger.Error("Failed to load config. Falling back to defaults.", ex);
            var fallback = new AppConfig();
            fallback.EnsureDefaults();
            return fallback;
        }
    }

    public async Task SaveAsync(AppConfig config)
    {
        await _saveGate.WaitAsync();
        var temporaryPath = ConfigPath + ".tmp";
        try
        {
            config.EnsureDefaults();
            var directory = Path.GetDirectoryName(ConfigPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            await using (var stream = File.Create(temporaryPath))
            {
                await JsonSerializer.SerializeAsync(stream, config, SerializerOptions);
                await stream.FlushAsync();
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, ConfigPath, overwrite: true);
        }
        catch (Exception ex)
        {
            _logger.Error("Failed to save config.", ex);
        }
        finally
        {
            _saveGate.Release();
        }
    }
}
