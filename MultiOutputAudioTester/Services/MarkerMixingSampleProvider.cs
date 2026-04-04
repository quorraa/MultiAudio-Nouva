using NAudio.Wave;

namespace MultiOutputAudioTester.Services;

public sealed class MarkerMixingSampleProvider : ISampleProvider
{
    private const int DefaultMaxDelayMilliseconds = 2000;
    private const int MarkerSequenceLength = 1023;
    private const int MarkerChipRate = 500;

    private readonly ISampleProvider _source;
    private readonly int _channels;
    private readonly int _sampleRate;
    private readonly RecentSampleHistory _delayedMarkerHistory;
    private readonly object _sync = new();
    private readonly float[] _markerSequence;
    private readonly float[] _markerDelayHistory;

    private float[] _sourceScratch = Array.Empty<float>();
    private float[] _delayedMarkerScratch = Array.Empty<float>();
    private int _markerDelayFrames;
    private int _markerDelayWriteIndex;
    private long _markerFramesWritten;
    private long _generatedFrames;
    private double _phase;
    private readonly double _phaseStep;
    private readonly int _chipSamples;
    private readonly double _carrierFrequencyHz;
    private double _markerLevelPercent;

    public MarkerMixingSampleProvider(ISampleProvider source, int slotIndex, double markerLevelPercent, int maxDelayMilliseconds = DefaultMaxDelayMilliseconds)
    {
        _source = source;
        _channels = source.WaveFormat.Channels;
        _sampleRate = source.WaveFormat.SampleRate;
        _chipSamples = Math.Max(1, _sampleRate / MarkerChipRate);
        _carrierFrequencyHz = GetCarrierFrequency(slotIndex);
        _phaseStep = Math.PI * 2 * _carrierFrequencyHz / _sampleRate;
        _markerSequence = BuildSequence(slotIndex, MarkerSequenceLength);
        _markerDelayHistory = new float[(_sampleRate * maxDelayMilliseconds / 1000) + 8];
        _delayedMarkerHistory = new RecentSampleHistory(_sampleRate * 12);
        MarkerLevelPercent = markerLevelPercent;
        WaveFormat = source.WaveFormat;
    }

    public WaveFormat WaveFormat { get; }

    public double CarrierFrequencyHz => _carrierFrequencyHz;

    public double MarkerLevelPercent
    {
        get
        {
            lock (_sync)
            {
                return _markerLevelPercent;
            }
        }
        set
        {
            lock (_sync)
            {
                _markerLevelPercent = Math.Clamp(value, 0, 5);
            }
        }
    }

    public int DelayMilliseconds
    {
        get
        {
            lock (_sync)
            {
                return _markerDelayFrames * 1000 / _sampleRate;
            }
        }
        set
        {
            lock (_sync)
            {
                _markerDelayFrames = Math.Clamp(value, 0, DefaultMaxDelayMilliseconds) * _sampleRate / 1000;
            }
        }
    }

    public bool TryCopyRecentMarkerWindow(int delayFrames, int lengthFrames, float[] destination)
    {
        return _delayedMarkerHistory.TryCopyLatestWindow(delayFrames, lengthFrames, destination);
    }

    public int Read(float[] buffer, int offset, int count)
    {
        EnsureScratchCapacity(count);
        var samplesRead = _source.Read(_sourceScratch, 0, count);
        for (var index = 0; index < count; index++)
        {
            buffer[offset + index] = index < samplesRead
                ? _sourceScratch[index]
                : 0f;
        }

        var framesRequested = count / _channels;
        if (framesRequested <= 0)
        {
            return samplesRead;
        }

        GenerateDelayedMarkers(framesRequested);

        for (var frame = 0; frame < framesRequested; frame++)
        {
            var delayedMarker = _delayedMarkerScratch[frame];
            for (var channel = 0; channel < _channels; channel++)
            {
                var bufferIndex = offset + (frame * _channels) + channel;
                buffer[bufferIndex] += delayedMarker;
            }
        }

        _delayedMarkerHistory.Append(_delayedMarkerScratch.AsSpan(0, framesRequested));
        return Math.Max(samplesRead, framesRequested * _channels);
    }

    private void GenerateDelayedMarkers(int framesRequested)
    {
        lock (_sync)
        {
            var amplitude = _markerLevelPercent / 100.0;
            for (var frame = 0; frame < framesRequested; frame++)
            {
                var chipIndex = (int)((_generatedFrames / _chipSamples) % _markerSequence.Length);
                var baseband = _markerSequence[chipIndex];
                var markerSample = (float)(Math.Sin(_phase) * baseband * amplitude);
                _phase += _phaseStep;
                if (_phase > Math.PI * 2)
                {
                    _phase -= Math.PI * 2;
                }

                _delayedMarkerScratch[frame] = ProcessDelayedMarker(markerSample);
                _generatedFrames++;
            }
        }
    }

    private float ProcessDelayedMarker(float inputSample)
    {
        var writeIndex = _markerDelayWriteIndex;
        _markerDelayHistory[writeIndex] = inputSample;

        float output = 0f;
        if (_markerFramesWritten >= _markerDelayFrames)
        {
            var readIndex = writeIndex - _markerDelayFrames;
            while (readIndex < 0)
            {
                readIndex += _markerDelayHistory.Length;
            }

            output = _markerDelayHistory[readIndex];
        }

        _markerDelayWriteIndex = (_markerDelayWriteIndex + 1) % _markerDelayHistory.Length;
        _markerFramesWritten++;
        return output;
    }

    private void EnsureScratchCapacity(int count)
    {
        if (_sourceScratch.Length < count)
        {
            _sourceScratch = new float[count];
        }

        var frames = Math.Max(1, count / _channels);
        if (_delayedMarkerScratch.Length < frames)
        {
            _delayedMarkerScratch = new float[frames];
        }
    }

    private static double GetCarrierFrequency(int slotIndex)
    {
        var carrierTable = new[] { 3450.0, 4350.0, 5250.0, 6150.0, 7050.0, 7950.0 };
        return carrierTable[(Math.Max(1, slotIndex) - 1) % carrierTable.Length];
    }

    private static float[] BuildSequence(int slotIndex, int length)
    {
        var sequence = new float[length];
        uint state = (uint)(0x9E3779B9u ^ (slotIndex * 0x85EBCA6Bu));
        for (var index = 0; index < length; index++)
        {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            sequence[index] = (state & 1) == 0 ? -1f : 1f;
        }

        return sequence;
    }
}
