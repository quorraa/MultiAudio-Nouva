namespace MultiOutputAudioTester.Config;

public sealed class DeviceProfileConfig
{
    private static readonly HashSet<string> AllowedIconTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "auto",
        "speaker",
        "bookshelf",
        "soundbar",
        "portable",
        "headphones"
    };

    public string? Alias { get; set; }

    public string IconType { get; set; } = "auto";

    public void EnsureDefaults()
    {
        Alias = string.IsNullOrWhiteSpace(Alias) ? null : Alias.Trim();
        IconType = NormalizeIconType(IconType);
    }

    public bool IsEmpty()
    {
        return string.IsNullOrWhiteSpace(Alias) && string.Equals(IconType, "auto", StringComparison.OrdinalIgnoreCase);
    }

    public static string NormalizeIconType(string? iconType)
    {
        var normalized = string.IsNullOrWhiteSpace(iconType) ? "auto" : iconType.Trim().ToLowerInvariant();
        return AllowedIconTypes.Contains(normalized) ? normalized : "auto";
    }
}
