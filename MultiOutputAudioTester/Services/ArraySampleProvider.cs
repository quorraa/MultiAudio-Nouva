using NAudio.Wave;

namespace MultiOutputAudioTester.Services;

public sealed class ArraySampleProvider : ISampleProvider
{
    private readonly float[] _samples;
    private int _position;

    public ArraySampleProvider(float[] samples, WaveFormat waveFormat)
    {
        _samples = samples;
        WaveFormat = waveFormat;
    }

    public WaveFormat WaveFormat { get; }

    public int Read(float[] buffer, int offset, int count)
    {
        var available = Math.Min(count, _samples.Length - _position);
        if (available <= 0)
        {
            return 0;
        }

        Array.Copy(_samples, _position, buffer, offset, available);
        _position += available;
        return available;
    }
}
