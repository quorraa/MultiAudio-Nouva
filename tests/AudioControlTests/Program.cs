using System.Text.Json;
using MultiOutputAudioTester.Config;
using MultiOutputAudioTester.Models;
using MultiOutputAudioTester.Services;
using NAudio.Wave;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
foreach (var count in new[] {1, 2, 3, 4})
{
    var config = new AppConfig { Outputs = OutputRouteConfig.CreateDefaults(count) };
    config.Outputs[^1].DelayMilliseconds = 127;
    config.EnsureDefaults();
    var reloaded = JsonSerializer.Deserialize<AppConfig>(JsonSerializer.Serialize(config))!;
    reloaded.EnsureDefaults();
    Check(reloaded.Outputs.Count == count, $"Saved {count}-output setup gained routes on load");
    Check(reloaded.Outputs[^1].DelayMilliseconds == 127, "Route settings were lost");
    Check(reloaded.Outputs.Count(r => r.IsTimingMaster) == 1, "Expected one timing master");
}
Check(OutputRouteConfig.Normalize([]).Count == 1, "Empty configuration needs one route");
var provider = new MarkerMixingSampleProvider(new Silence(), 1, 1.6) { DelayMilliseconds = 100 };
var buffer = new float[24000];
provider.Read(buffer, 0, buffer.Length);
Check(buffer.Any(s => s != 0), "Enabled markers produced no signal");
provider.MarkerLevelPercent = 0;
provider.Read(buffer, 0, 960);
Check(buffer.Take(960).All(s => s == 0), "Muted markers leaked from the delay line");
provider.MarkerLevelPercent = 1.6;
provider.Read(buffer, 0, buffer.Length);
Check(buffer.Any(s => s != 0), "Markers failed to resume");
Console.WriteLine("PASS: 1/2/3/4-output config round trips; marker noise mutes without delayed leakage and resumes.");

sealed class Silence : ISampleProvider
{
    public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
    public int Read(float[] buffer, int offset, int count) { Array.Clear(buffer, offset, count); return count; }
}
