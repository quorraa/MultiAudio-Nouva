namespace MultiOutputAudioTester.Services;

public sealed class RecentSampleHistory
{
    private readonly float[] _buffer;
    private readonly object _sync = new();

    private int _writeIndex;
    private long _samplesWritten;

    public RecentSampleHistory(int capacitySamples)
    {
        if (capacitySamples <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(capacitySamples));
        }

        _buffer = new float[capacitySamples];
    }

    public int CapacitySamples => _buffer.Length;

    public long SamplesWritten
    {
        get
        {
            lock (_sync)
            {
                return _samplesWritten;
            }
        }
    }

    public void Clear()
    {
        lock (_sync)
        {
            Array.Clear(_buffer);
            _writeIndex = 0;
            _samplesWritten = 0;
        }
    }

    public void Append(ReadOnlySpan<float> samples)
    {
        if (samples.Length == 0)
        {
            return;
        }

        lock (_sync)
        {
            foreach (var sample in samples)
            {
                _buffer[_writeIndex] = sample;
                _writeIndex = (_writeIndex + 1) % _buffer.Length;
                _samplesWritten++;
            }
        }
    }

    public bool TryCopyLatestWindow(int delaySamples, int lengthSamples, float[] destination)
    {
        if (destination.Length < lengthSamples)
        {
            throw new ArgumentException("Destination buffer is smaller than the requested window.", nameof(destination));
        }

        if (delaySamples < 0 || lengthSamples <= 0)
        {
            return false;
        }

        lock (_sync)
        {
            if (_samplesWritten < delaySamples + lengthSamples)
            {
                return false;
            }

            var endExclusive = _samplesWritten - delaySamples;
            var start = endExclusive - lengthSamples;
            var oldestAvailable = Math.Max(0, _samplesWritten - _buffer.Length);
            if (start < oldestAvailable)
            {
                return false;
            }

            for (var index = 0; index < lengthSamples; index++)
            {
                var logicalIndex = start + index;
                destination[index] = _buffer[(int)(logicalIndex % _buffer.Length)];
            }

            return true;
        }
    }
}
