namespace MultiOutputAudioTester.Models;

public sealed class OutputRouteConfig
{
    public int SlotIndex { get; set; }

    public string? DeviceId { get; set; }

    public double VolumePercent { get; set; } = 100;

    public int DelayMilliseconds { get; set; }

    public bool IsTimingMaster { get; set; }

    public static List<OutputRouteConfig> CreateDefaults(int count = 3)
    {
        count = Math.Max(1, count);
        var outputs = new List<OutputRouteConfig>(count);
        for (var index = 1; index <= count; index++)
        {
            outputs.Add(new OutputRouteConfig
            {
                SlotIndex = index,
                VolumePercent = 100,
                DelayMilliseconds = 0,
                IsTimingMaster = index == 1
            });
        }

        return outputs;
    }

    public static List<OutputRouteConfig> Normalize(IEnumerable<OutputRouteConfig>? outputs, int minimumCount = 3)
    {
        minimumCount = Math.Max(1, minimumCount);
        if (outputs is null)
        {
            return CreateDefaults(minimumCount);
        }

        var normalized = outputs
            .OrderBy(output => output.SlotIndex)
            .Select((output, index) => new OutputRouteConfig
            {
                SlotIndex = index + 1,
                DeviceId = output.DeviceId,
                VolumePercent = Math.Clamp(output.VolumePercent, 0, 100),
                DelayMilliseconds = Math.Clamp(output.DelayMilliseconds, 0, 2000),
                IsTimingMaster = output.IsTimingMaster
            })
            .ToList();

        while (normalized.Count < minimumCount)
        {
            normalized.Add(new OutputRouteConfig
            {
                SlotIndex = normalized.Count + 1,
                VolumePercent = 100,
                DelayMilliseconds = 0,
                IsTimingMaster = normalized.Count == 0
            });
        }

        if (!normalized.Any(output => output.IsTimingMaster))
        {
            normalized[0].IsTimingMaster = true;
        }
        else
        {
            var firstMaster = normalized.First(output => output.IsTimingMaster).SlotIndex;
            foreach (var output in normalized)
            {
                output.IsTimingMaster = output.SlotIndex == firstMaster;
            }
        }

        return normalized;
    }
}
