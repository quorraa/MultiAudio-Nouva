namespace MultiOutputAudioTester.Models;

public sealed class CalibrationSessionResult
{
    public List<CalibrationOutputResult> Outputs { get; init; } = [];

    public bool Succeeded => Outputs.Count > 0 && Outputs.All(output => output.Succeeded);

    public string Summary
    {
        get
        {
            if (Outputs.Count == 0)
            {
                return "Calibration did not produce any results.";
            }

            var successful = Outputs.Where(output => output.Succeeded).ToList();
            if (successful.Count == 0)
            {
                return "Calibration failed to detect any output arrivals.";
            }

            return string.Join(", ", successful.OrderBy(output => output.SlotIndex)
                .Select(output => $"O{output.SlotIndex}={output.SuggestedDelayMilliseconds} ms"));
        }
    }
}
