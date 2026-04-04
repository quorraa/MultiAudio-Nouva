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

    public ConfigurationService(AppLogger logger)
    {
        _logger = logger;
        ConfigPath = Path.Combine(
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
        try
        {
            config.EnsureDefaults();
            var directory = Path.GetDirectoryName(ConfigPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            await using var stream = File.Create(ConfigPath);
            await JsonSerializer.SerializeAsync(stream, config, SerializerOptions);
        }
        catch (Exception ex)
        {
            _logger.Error("Failed to save config.", ex);
        }
    }
}
