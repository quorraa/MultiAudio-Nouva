using MultiOutputAudioTester.Services;

const int rate = 48000;
static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
double[] frequencies = [700, 1400, 2800, 4200];
for (var slot = 1; slot <= 4; slot++)
for (var beat = 0; beat < 4; beat++)
{
    Check(SyncTickPattern.BeatAt(beat * rate, rate) == beat + 1, "Beat boundary is incorrect");
    Check(SyncTickPattern.SampleAt(beat * rate, rate, slot) == 0, "Onset must start at zero");
    var energies = new double[4];
    for (var candidate = 0; candidate < 4; candidate++)
    {
        double real = 0, imaginary = 0;
        for (var frame = 0; frame < rate / 10; frame++)
        {
            var sample = SyncTickPattern.SampleAt(beat * rate + frame, rate, slot);
            Check(Math.Abs(sample) <= 0.24, "Tick exceeds amplitude bound");
            real += sample * Math.Cos(2 * Math.PI * frequencies[candidate] * frame / rate);
            imaginary += sample * Math.Sin(2 * Math.PI * frequencies[candidate] * frame / rate);
            Check(sample == SyncTickPattern.SampleAt((beat + 4) * rate + frame, rate, slot), "Phrase is not periodic");
        }
        energies[candidate] = real * real + imaginary * imaginary;
    }
    Check(Array.IndexOf(energies, energies.Max()) == slot - 1, "Speaker pitch changed or is not distinguishable");
    for (var frame = rate / 5; frame < rate; frame++)
        Check(SyncTickPattern.SampleAt(beat * rate + frame, rate, slot) == 0, "Inter-beat silence is not silent");
}
for (var slot = 1; slot <= 4; slot++)
    for (var frame = 1; frame < rate / 25; frame++)
        Check(Math.Abs(SyncTickPattern.SampleAt(frame, rate, slot) * 0.14 / 0.24 - SyncTickPattern.SampleAt(rate + frame, rate, slot)) < 1e-7, "Accent changed onset or pitch");
Check(SyncTickPattern.BeatAt(rate * 4, rate) == 1, "Downbeat did not repeat");
Check(SyncTickPattern.SampleAt(-1, rate) == 0, "Negative frame should be silent");
Console.WriteLine("PASS: four fixed speaker pitches across every beat, beat boundaries, exact phrase repetition, amplitude bounds, and inter-beat silence.");
if (args.Length > 0)
{
    var path = Path.GetFullPath(args[0]);
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    using var writer = new BinaryWriter(File.Create(path));
    const int frames = rate * 16;
    writer.Write("RIFF"u8); writer.Write(36 + frames * 2); writer.Write("WAVEfmt "u8);
    writer.Write(16); writer.Write((short)1); writer.Write((short)1); writer.Write(rate);
    writer.Write(rate * 2); writer.Write((short)2); writer.Write((short)16);
    writer.Write("data"u8); writer.Write(frames * 2);
    for (var frame = 0; frame < frames; frame++) writer.Write((short)(SyncTickPattern.SampleAt(frame, rate, frame / (rate * 4) + 1) * short.MaxValue));
    Console.WriteLine($"Preview written to {path}");
}
