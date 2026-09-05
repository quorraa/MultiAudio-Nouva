namespace MultiOutputAudioTester.Services;

/// <summary>Speaker-specific clicks with a shared, accented four-beat clock.</summary>
public static class SyncTickPattern
{
    // Pitch identifies the output, never the beat. All voices start together.
    private static readonly double[] Frequencies = [700, 1400, 2800, 4200];
    public const int BeatsPerPhrase = 4;

    public static int BeatAt(long frame, int sampleRate)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(sampleRate);
        return (int)(Math.Max(0, frame) / sampleRate % BeatsPerPhrase) + 1;
    }

    public static float SampleAt(long frame, int sampleRate, int slotIndex = 1)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(sampleRate);
        if (frame < 0) return 0;
        var beat = (int)(frame / sampleRate % BeatsPerPhrase);
        var age = (frame % sampleRate) / (double)sampleRate;
        const double duration = 0.035;
        if (age >= duration) return 0;

        // A short attack and fade avoid discontinuities, while retaining a clear onset.
        var envelope = Math.Min(1, age / 0.0003) * Math.Exp(-age / 0.007)
            * Math.Min(1, (duration - age) / 0.003);
        var voice = (Math.Max(1, slotIndex) - 1) % Frequencies.Length;
        var phase = 2 * Math.PI * Frequencies[voice] * age;
        return (float)(Math.Sin(phase) * envelope * (beat == 0 ? 0.24 : 0.14));
    }
}
